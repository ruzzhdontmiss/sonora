#!/usr/bin/env node
/**
 * SONORA Pre-push Secret Scanner
 * Scans repository files and Git tracking status for hardcoded secrets,
 * private keys, real tokens, and ensures real .env files are never tracked.
 * Strictly enforces RULES.md Section 5 and Section 6.
 *
 * NOTE: Line-level keyword bypasses (such as comments containing "example")
 * are strictly prohibited to prevent masking real compromised credentials.
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { execSync } from "child_process";

const ROOT_DIR = process.cwd();

// Patterns that indicate secrets or prohibited constructs
const CRITICAL_SECRET_PATTERNS = [
  { name: "Private Key Header", regex: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/ },
  { name: "PGP Private Key", regex: /-----BEGIN PGP PRIVATE KEY BLOCK-----/ },
  { name: "Unsafe NEXT_PUBLIC_ Secret", regex: /NEXT_PUBLIC_[A-Z0-9_]*(SECRET|PASSWORD|PRIVATE|TOKEN|KEY)/ },
  { name: "GitHub Token", regex: /gh[pousr]_[A-Za-z0-9_]{36,}/ },
  { name: "Slack / Discord Token", regex: /xox[baprs]-[0-9a-zA-Z]{10,}/ },
  { name: "AWS Access Key", regex: /AKIA[0-9A-Z]{16}/ },
];

// Value-matching patterns for generic assignments
const VALUE_SECRET_PATTERNS = [
  {
    name: "Generic API Key Assignment",
    regex: /(?:api_key|apikey|client_secret|clientsecret)\s*[:=]\s*["']([^"']+)["']/i,
  },
  {
    name: "Bearer Token Hardcoded",
    regex: /bearer\s+([a-zA-Z0-9_\-\.]{30,})/i,
  },
];

// Directories and files to ignore during file tree scan
const IGNORED_PATHS = [
  ".git",
  "node_modules",
  ".next",
  "dist",
  "coverage",
  ".pnpm-store",
  ".env",
  ".env.local",
  ".env.example",
  "pnpm-lock.yaml",
  "package-lock.json",
  "scripts/secret-scan.mjs",
  "secret-scan.mjs",
];

const KNOWN_SAFE_EXACT_VALUES = [
  "placeholder",
  "replace-with",
  "synthetic_test_hash",
  "synthetic_test_hash_not_a_real_credential",
];

let violations = [];

// 1. Verify that Git is NOT tracking any secret files
try {
  const trackedFilesOutput = execSync("git ls-files", { encoding: "utf-8" });
  const trackedFiles = trackedFilesOutput.split("\n").filter(Boolean);

  for (const file of trackedFiles) {
    if (file === ".env" || (file.startsWith(".env.") && file !== ".env.example")) {
      violations.push({
        file,
        line: 1,
        rule: "CRITICAL: Real environment file is tracked by Git",
      });
    }
    if (file.endsWith(".p8") || file.endsWith(".pem") || file.endsWith(".key")) {
      violations.push({
        file,
        line: 1,
        rule: "CRITICAL: Private key/certificate file is tracked by Git",
      });
    }
  }
} catch {
  // Git not available or empty
}

// 2. Scan code files on disk for accidental hardcoded secrets
function scanFile(filePath) {
  const relPath = relative(ROOT_DIR, filePath);

  // Prohibited file extensions
  if (relPath.endsWith(".p8") || relPath.endsWith(".pem") || relPath.endsWith(".key")) {
    violations.push({ file: relPath, line: 1, rule: "Prohibited key file extension present on disk" });
    return;
  }

  let content;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return; // binary or unreadable file
  }

  const lines = content.split("\n");
  lines.forEach((lineText, idx) => {
    // 2a. Critical patterns: NEVER bypassed by comments or keywords
    for (const pattern of CRITICAL_SECRET_PATTERNS) {
      if (pattern.regex.test(lineText)) {
        violations.push({
          file: relPath,
          line: idx + 1,
          rule: pattern.name,
          preview: lineText.trim().substring(0, 40) + "...",
        });
      }
    }

    // 2b. Value-based patterns: check the extracted value itself, not the surrounding comment
    for (const pattern of VALUE_SECRET_PATTERNS) {
      const match = pattern.regex.exec(lineText);
      if (match && match[1]) {
        const extractedValue = match[1].trim();
        const isSafePlaceholder = KNOWN_SAFE_EXACT_VALUES.some(
          (safeVal) => extractedValue.toLowerCase().startsWith(safeVal)
        );
        if (!isSafePlaceholder && extractedValue.length >= 20) {
          violations.push({
            file: relPath,
            line: idx + 1,
            rule: pattern.name,
            preview: lineText.trim().substring(0, 40) + "...",
          });
        }
      }
    }
  });
}

function walkDir(dir) {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    if (IGNORED_PATHS.includes(entry)) continue;
    if (entry.startsWith(".env.") && entry !== ".env.example") continue;
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      walkDir(fullPath);
    } else if (stat.isFile()) {
      scanFile(fullPath);
    }
  }
}

console.log("🔍 Running SONORA Secret Scan...");
walkDir(ROOT_DIR);

if (violations.length > 0) {
  console.error(
    `\n❌ SECRET SCAN FAILED! Found ${violations.length} potential secret issue(s):`
  );
  violations.forEach((v) => {
    console.error(`  - [${v.file}:${v.line}] Rule: ${v.rule}`);
  });
  process.exit(1);
} else {
  console.log("✅ Secret scan passed cleanly. No secrets or tracked .env files detected.\n");
  process.exit(0);
}
