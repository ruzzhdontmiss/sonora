/**
 * Synthetic Data Seed Script for SONORA
 * Strictly uses synthetic / demo data only.
 * No real user data or live credentials.
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Seeding synthetic test database...");

  // Repeatable upsert for synthetic test user
  const syntheticUser = await prisma.user.upsert({
    where: { email: "synthetic-user@example.com" },
    update: {
      displayName: "Synthetic Demo User",
    },
    create: {
      id: "00000000-0000-0000-0000-000000000001",
      email: "synthetic-user@example.com",
      displayName: "Synthetic Demo User",
      passwordHash: "synthetic_test_hash_not_a_real_credential",
    },
  });

  console.log(`✅ Seeded synthetic user: ${syntheticUser.email} (${syntheticUser.id})`);
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
