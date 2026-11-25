import { randomUUID } from "crypto";
import { Redis } from "ioredis";
import { getRedisClient } from "@/lib/redis";
import { ProviderQuotaExhaustedError } from "@/modules/providers/errors";
import {
  DEFAULT_YOUTUBE_GENERAL_QUOTA_LIMIT,
  DEFAULT_YOUTUBE_SEARCH_QUOTA_LIMIT,
  getPacificTimeResetWindow,
} from "./youtube-quota-constants";
import { YouTubeQuotaStore } from "./youtube-quota-store.interface";
import {
  ProjectQuotaStatus,
  QuotaConsumptionRequest,
  QuotaConsumptionResult,
  QuotaReleaseRequest,
  QuotaReservationRequest,
  QuotaReservationResult,
} from "./youtube-quota-types";

const RESERVE_QUOTA_LUA = `
local used_gen = tonumber(redis.call('GET', KEYS[1]) or '0')
local res_gen = tonumber(redis.call('GET', KEYS[2]) or '0')
local used_sea = tonumber(redis.call('GET', KEYS[3]) or '0')
local res_sea = tonumber(redis.call('GET', KEYS[4]) or '0')

local req_gen = tonumber(ARGV[1])
local req_sea = tonumber(ARGV[2])
local max_gen = tonumber(ARGV[3])
local max_sea = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])
local res_token = ARGV[6]
local lease_sec = tonumber(ARGV[7])
local idem_key = ARGV[8]

-- Idempotent check
if idem_key ~= 'NONE' then
  local existing_tok = redis.call('GET', KEYS[6])
  if existing_tok then
    local existing_raw = redis.call('GET', 'sonora:quota:youtube:' .. ARGV[9] .. ':res:' .. existing_tok)
    if existing_raw then
      return {2, existing_raw}
    end
  end
end

if (used_gen + res_gen + req_gen) > max_gen then
  return {0, 1, used_gen + res_gen, max_gen}
end

if (used_sea + res_sea + req_sea) > max_sea then
  return {0, 2, used_sea + res_sea, max_sea}
end

local new_res_gen = redis.call('INCRBY', KEYS[2], req_gen)
local new_res_sea = redis.call('INCRBY', KEYS[4], req_sea)

-- Set day-level TTLs if newly created
if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ttl) end
if redis.call('TTL', KEYS[2]) < 0 then redis.call('EXPIRE', KEYS[2], ttl) end
if redis.call('TTL', KEYS[3]) < 0 then redis.call('EXPIRE', KEYS[3], ttl) end
if redis.call('TTL', KEYS[4]) < 0 then redis.call('EXPIRE', KEYS[4], ttl) end

-- Save reservation with lease expiration
local res_payload = cjson.encode({
  reservationToken = res_token,
  generalUnits = req_gen,
  searchCalls = req_sea,
  idempotencyKey = idem_key
})
redis.call('SETEX', KEYS[5], lease_sec, res_payload)

if idem_key ~= 'NONE' then
  redis.call('SETEX', KEYS[6], lease_sec, res_token)
end

return {1, used_gen + new_res_gen, used_sea + new_res_sea}
`;

const COMMIT_QUOTA_LUA = `
local res_raw = redis.call('GET', KEYS[5])
if not res_raw then return 0 end
local res = cjson.decode(res_raw)
local req_gen = tonumber(res.generalUnits or '0')
local req_sea = tonumber(res.searchCalls or '0')

local cur_res_gen = tonumber(redis.call('GET', KEYS[2]) or '0')
local cur_res_sea = tonumber(redis.call('GET', KEYS[4]) or '0')

redis.call('SET', KEYS[2], tostring(math.max(0, cur_res_gen - req_gen)), 'KEEPTTL')
redis.call('SET', KEYS[4], tostring(math.max(0, cur_res_sea - req_sea)), 'KEEPTTL')

redis.call('INCRBY', KEYS[1], req_gen)
redis.call('INCRBY', KEYS[3], req_sea)

redis.call('DEL', KEYS[5])
if res.idempotencyKey and res.idempotencyKey ~= 'NONE' then
  redis.call('DEL', KEYS[6])
end
return 1
`;

const RELEASE_QUOTA_LUA = `
local res_raw = redis.call('GET', KEYS[3])
local req_gen = 0
local req_sea = 0

if res_raw then
  local res = cjson.decode(res_raw)
  req_gen = tonumber(res.generalUnits or '0')
  req_sea = tonumber(res.searchCalls or '0')
  redis.call('DEL', KEYS[3])
  if res.idempotencyKey and res.idempotencyKey ~= 'NONE' then
    redis.call('DEL', KEYS[4])
  end
else
  req_gen = tonumber(ARGV[1] or '0')
  req_sea = tonumber(ARGV[2] or '0')
end

local cur_res_gen = tonumber(redis.call('GET', KEYS[1]) or '0')
local cur_res_sea = tonumber(redis.call('GET', KEYS[2]) or '0')

redis.call('SET', KEYS[1], tostring(math.max(0, cur_res_gen - req_gen)), 'KEEPTTL')
redis.call('SET', KEYS[2], tostring(math.max(0, cur_res_sea - req_sea)), 'KEEPTTL')
return 1
`;

/**
 * Concurrency-safe, Redis-backed YouTube Quota Store.
 * Executes atomic Lua scripts for reservations, commits, releases, and lease expiration.
 */
export class RedisYouTubeQuotaStore implements YouTubeQuotaStore {
  private redis: Redis;
  private defaultProjectId: string;

  constructor(redis?: Redis, defaultProjectId: string = "sonora-default-google-project") {
    this.redis = redis ?? getRedisClient();
    this.defaultProjectId = defaultProjectId;
  }

  private getGeneralUsedKey(projectId: string, pacificDate: string): string {
    return `sonora:quota:youtube:${projectId}:${pacificDate}:general:used`;
  }

  private getGeneralReservedKey(projectId: string, pacificDate: string): string {
    return `sonora:quota:youtube:${projectId}:${pacificDate}:general:reserved`;
  }

  private getSearchUsedKey(projectId: string, pacificDate: string): string {
    return `sonora:quota:youtube:${projectId}:${pacificDate}:search:used`;
  }

  private getSearchReservedKey(projectId: string, pacificDate: string): string {
    return `sonora:quota:youtube:${projectId}:${pacificDate}:search:reserved`;
  }

  private getReservationKey(projectId: string, reservationToken: string): string {
    return `sonora:quota:youtube:${projectId}:res:${reservationToken}`;
  }

  private getIdempotencyKey(projectId: string, idempotencyKey: string): string {
    return `sonora:quota:youtube:${projectId}:idem:${idempotencyKey}`;
  }

  public async reserve(request: QuotaReservationRequest): Promise<QuotaReservationResult> {
    const projectId = request.projectId || this.defaultProjectId;
    const generalRequested = Math.max(0, request.generalUnits);
    const searchRequested = Math.max(0, request.searchCalls ?? 0);
    const generalLimit = request.customGeneralLimit ?? DEFAULT_YOUTUBE_GENERAL_QUOTA_LIMIT;
    const searchLimit = request.customSearchLimit ?? DEFAULT_YOUTUBE_SEARCH_QUOTA_LIMIT;
    const leaseDurationSeconds = request.leaseDurationSeconds ?? 300;
    const idempotencyKey = request.idempotencyKey || "NONE";

    const { pacificDate, nextMidnightUtc, secondsUntilReset } = getPacificTimeResetWindow(
      request.now
    );
    const ttlSeconds = Math.max(3600, secondsUntilReset + 172800);
    const reservationToken = randomUUID();

    const genUsedKey = this.getGeneralUsedKey(projectId, pacificDate);
    const genResKey = this.getGeneralReservedKey(projectId, pacificDate);
    const seaUsedKey = this.getSearchUsedKey(projectId, pacificDate);
    const seaResKey = this.getSearchReservedKey(projectId, pacificDate);
    const resKey = this.getReservationKey(projectId, reservationToken);
    const idemKey = this.getIdempotencyKey(projectId, idempotencyKey);

    const rawResult = (await this.redis.eval(
      RESERVE_QUOTA_LUA,
      6,
      genUsedKey,
      genResKey,
      seaUsedKey,
      seaResKey,
      resKey,
      idemKey,
      generalRequested,
      searchRequested,
      generalLimit,
      searchLimit,
      ttlSeconds,
      reservationToken,
      leaseDurationSeconds,
      idempotencyKey,
      projectId
    )) as [number, string | number, number?, number?];

    const statusCode = rawResult[0];

    // Idempotent Replay
    if (statusCode === 2) {
      const existing = JSON.parse(rawResult[1] as string) as {
        reservationToken: string;
        generalUnits: number;
        searchCalls: number;
        idempotencyKey: string;
      };
      const status = await this.getStatus(projectId, request.now);
      return {
        success: true,
        reservationToken: existing.reservationToken,
        idempotencyKey: existing.idempotencyKey !== "NONE" ? existing.idempotencyKey : undefined,
        isReplay: true,
        projectId,
        pacificDate,
        generalUnitsReserved: existing.generalUnits,
        searchCallsReserved: existing.searchCalls,
        remainingGeneralUnits: status.remainingGeneralUnits,
        remainingSearchCalls: status.remainingSearchCalls,
        resetsAt: nextMidnightUtc,
        secondsUntilReset,
        expiresAt: new Date(Date.now() + leaseDurationSeconds * 1000),
      };
    }

    // Quota Exhausted
    if (statusCode === 0) {
      const bucketCode = rawResult[1];
      const current = (rawResult[2] as number) ?? 0;
      if (bucketCode === 1) {
        throw new ProviderQuotaExhaustedError({
          provider: "YOUTUBE_MUSIC",
          quotaBucket: "GENERAL",
          limit: generalLimit,
          requested: generalRequested,
          remaining: Math.max(0, generalLimit - current),
          resetsAt: nextMidnightUtc,
          projectId,
        });
      } else {
        throw new ProviderQuotaExhaustedError({
          provider: "YOUTUBE_MUSIC",
          quotaBucket: "SEARCH",
          limit: searchLimit,
          requested: searchRequested,
          remaining: Math.max(0, searchLimit - current),
          resetsAt: nextMidnightUtc,
          projectId,
        });
      }
    }

    const totalGen = rawResult[1] as number;
    const totalSea = rawResult[2] as number;

    return {
      success: true,
      reservationToken,
      idempotencyKey: request.idempotencyKey,
      isReplay: false,
      projectId,
      pacificDate,
      generalUnitsReserved: generalRequested,
      searchCallsReserved: searchRequested,
      remainingGeneralUnits: Math.max(0, generalLimit - totalGen),
      remainingSearchCalls: Math.max(0, searchLimit - totalSea),
      resetsAt: nextMidnightUtc,
      secondsUntilReset,
      expiresAt: new Date(Date.now() + leaseDurationSeconds * 1000),
    };
  }

  public async commit(reservationToken: string, projectId?: string): Promise<void> {
    const pid = projectId || this.defaultProjectId;
    const { pacificDate } = getPacificTimeResetWindow();
    const genUsedKey = this.getGeneralUsedKey(pid, pacificDate);
    const genResKey = this.getGeneralReservedKey(pid, pacificDate);
    const seaUsedKey = this.getSearchUsedKey(pid, pacificDate);
    const seaResKey = this.getSearchReservedKey(pid, pacificDate);
    const resKey = this.getReservationKey(pid, reservationToken);
    const idemKey = `sonora:quota:youtube:${pid}:idem:*`;

    await this.redis.eval(
      COMMIT_QUOTA_LUA,
      6,
      genUsedKey,
      genResKey,
      seaUsedKey,
      seaResKey,
      resKey,
      idemKey
    );
  }

  public async consume(request: QuotaConsumptionRequest): Promise<QuotaConsumptionResult> {
    const res = await this.reserve({
      projectId: request.projectId,
      generalUnits: request.generalUnits,
      searchCalls: request.searchCalls,
      customGeneralLimit: request.customGeneralLimit,
      customSearchLimit: request.customSearchLimit,
      now: request.now,
    });

    await this.commit(res.reservationToken, res.projectId);

    return {
      success: true,
      projectId: res.projectId,
      pacificDate: res.pacificDate,
      generalUnitsConsumed: res.generalUnitsReserved,
      searchCallsConsumed: res.searchCallsReserved,
      remainingGeneralUnits: res.remainingGeneralUnits,
      remainingSearchCalls: res.remainingSearchCalls,
      resetsAt: res.resetsAt,
      secondsUntilReset: res.secondsUntilReset,
    };
  }

  public async release(request: QuotaReleaseRequest): Promise<void> {
    const projectId = request.projectId || this.defaultProjectId;
    const pacificDate =
      request.pacificDate || getPacificTimeResetWindow().pacificDate;
    const genResKey = this.getGeneralReservedKey(projectId, pacificDate);
    const seaResKey = this.getSearchReservedKey(projectId, pacificDate);
    const resKey = request.reservationToken
      ? this.getReservationKey(projectId, request.reservationToken)
      : "NONE";
    const idemKey = `sonora:quota:youtube:${projectId}:idem:*`;

    await this.redis.eval(
      RELEASE_QUOTA_LUA,
      4,
      genResKey,
      seaResKey,
      resKey,
      idemKey,
      Math.max(0, request.generalUnits),
      Math.max(0, request.searchCalls ?? 0)
    );
  }

  public async getStatus(projectId?: string, now?: Date): Promise<ProjectQuotaStatus> {
    const pid = projectId || this.defaultProjectId;
    const { pacificDate, nextMidnightUtc, secondsUntilReset } = getPacificTimeResetWindow(now);
    const genUsedKey = this.getGeneralUsedKey(pid, pacificDate);
    const genResKey = this.getGeneralReservedKey(pid, pacificDate);
    const seaUsedKey = this.getSearchUsedKey(pid, pacificDate);
    const seaResKey = this.getSearchReservedKey(pid, pacificDate);

    const [genUsedRaw, genResRaw, seaUsedRaw, seaResRaw] = await Promise.all([
      this.redis.get(genUsedKey),
      this.redis.get(genResKey),
      this.redis.get(seaUsedKey),
      this.redis.get(seaResKey),
    ]);

    const usedGeneral = parseInt(genUsedRaw || "0", 10);
    const reservedGeneral = parseInt(genResRaw || "0", 10);
    const usedSearch = parseInt(seaUsedRaw || "0", 10);
    const reservedSearch = parseInt(seaResRaw || "0", 10);

    const remainingGeneral = Math.max(
      0,
      DEFAULT_YOUTUBE_GENERAL_QUOTA_LIMIT - (usedGeneral + reservedGeneral)
    );
    const remainingSearch = Math.max(
      0,
      DEFAULT_YOUTUBE_SEARCH_QUOTA_LIMIT - (usedSearch + reservedSearch)
    );

    return {
      projectId: pid,
      pacificDate,
      usedGeneralUnits: usedGeneral,
      reservedGeneralUnits: reservedGeneral,
      remainingGeneralUnits: remainingGeneral,
      generalLimit: DEFAULT_YOUTUBE_GENERAL_QUOTA_LIMIT,
      usedSearchCalls: usedSearch,
      reservedSearchCalls: reservedSearch,
      remainingSearchCalls: remainingSearch,
      searchLimit: DEFAULT_YOUTUBE_SEARCH_QUOTA_LIMIT,
      resetsAt: nextMidnightUtc,
      secondsUntilReset,
    };
  }

  public async reset(projectId?: string, now?: Date): Promise<void> {
    const pid = projectId || this.defaultProjectId;
    const { pacificDate } = getPacificTimeResetWindow(now);
    const genUsedKey = this.getGeneralUsedKey(pid, pacificDate);
    const genResKey = this.getGeneralReservedKey(pid, pacificDate);
    const seaUsedKey = this.getSearchUsedKey(pid, pacificDate);
    const seaResKey = this.getSearchReservedKey(pid, pacificDate);

    await this.redis.del(genUsedKey, genResKey, seaUsedKey, seaResKey);
  }
}
