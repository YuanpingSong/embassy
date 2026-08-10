#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PUBLIC_PACKAGE_PATHS = [
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "README.zh-CN.md",
  "SECURITY.md",
  "assets/live-dashboard/app.css",
  "assets/mark-seal.svg",
  "assets/mark.svg",
  "assets/social-preview.png",
  "assets/vendor/react/LICENSE",
  "assets/vendor/react/react-dom.production.min.js",
  "assets/vendor/react/react.production.min.js",
  "docs/DESIGN.md",
  "docs/GATEWAY-ARCHITECTURE.md",
  "package.json",
  "skills/embassy-peer/SKILL.md",
  "skills/embassy-peer/agents/openai.yaml",
];

const GATEWAY_RUNTIME_MODULES = [
  "claude-compatibility-scratch",
  "claude-peer",
  "claude-helper",
  "claude-helper-client",
  "claude-helper-protocol",
  "claude-helper-supervisor",
  "claude-runtime",
  "cli",
  "cli-copy",
  "cli-copy.en",
  "cli-copy.zh-CN",
  "codex-app-server",
  "codex-local-transport",
  "codex-registration-generation",
  "codex-registration-succession",
  "compatibility",
  "config",
  "control",
  "dashboard",
  "dashboard-copy",
  "dashboard-copy.en",
  "dashboard-copy.zh-CN",
  "dashboard-model",
  "delivery-machine",
  "instance-lease",
  "live-dashboard",
  "live-dashboard-assets",
  "live-dashboard-bootstrap",
  "live-dashboard-command",
  "live-dashboard-http",
  "live-dashboard-protocol",
  "live-dashboard-server",
  "live-dashboard-stream",
  "locale",
  "progress-watch-machine",
  "provenance-envelope",
  "providers",
  "server",
  "service",
  "store",
  "types",
];

const ROOT_RUNTIME_MODULES = ["errors", "mutex"];
const RUNTIME_SUFFIXES = ["d.ts", "js", "js.map"];

function runtimePaths(directory, modules) {
  return modules.flatMap((module) =>
    RUNTIME_SUFFIXES.map((suffix) => `${directory}/${module}.${suffix}`),
  );
}

export const EXPECTED_NPM_PACKAGE_PATHS = Object.freeze(
  [
    ...PUBLIC_PACKAGE_PATHS,
    ...runtimePaths("dist/src/gateway", GATEWAY_RUNTIME_MODULES),
    ...runtimePaths("dist/src", ROOT_RUNTIME_MODULES),
    "dist/src/gateway/live-dashboard-app/app.js",
  ].sort(),
);

const REQUIRED_ESM_IMPORTS = [
  "dist/src/gateway/cli.js",
  "dist/src/gateway/claude-compatibility-scratch.js",
  "dist/src/gateway/claude-helper.js",
  "dist/src/gateway/claude-helper-client.js",
  "dist/src/gateway/codex-registration-succession.js",
  "dist/src/gateway/compatibility.js",
  "dist/src/gateway/dashboard.js",
  "dist/src/gateway/delivery-machine.js",
  "dist/src/gateway/live-dashboard.js",
  "dist/src/gateway/server.js",
];

function fail(message) {
  throw new Error(message);
}

function expectedTarballFilename(pkg) {
  return `${pkg.name.replace(/^@/, "").replaceAll("/", "-")}-${pkg.version}.tgz`;
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
}

export function verifyPackageReport(pkg, reports, expectedTarball) {
  assertPlainObject(pkg, "package.json");
  if (!Array.isArray(reports) || reports.length !== 1) {
    fail("Expected exactly one npm package report");
  }

  const [report] = reports;
  assertPlainObject(report, "npm package report");
  const filename = expectedTarballFilename(pkg);
  if (report.name !== pkg.name || report.version !== pkg.version) {
    fail("npm package identity does not match package.json");
  }
  if (report.filename !== filename) {
    fail(`Unexpected package filename: ${String(report.filename)}`);
  }
  if (expectedTarball !== undefined && path.basename(expectedTarball) !== filename) {
    fail(`Expected tarball path to end in ${filename}`);
  }
  if (!Array.isArray(report.files)) {
    fail("npm package report files must be an array");
  }

  const actualPaths = report.files.map((file, index) => {
    assertPlainObject(file, `npm package report file ${index}`);
    if (typeof file.path !== "string" || file.path.length === 0) {
      fail(`npm package report file ${index} has no path`);
    }
    return file.path;
  });
  const actualPathSet = new Set(actualPaths);
  if (actualPathSet.size !== actualPaths.length) {
    fail("npm package report contains duplicate paths");
  }

  const expectedPathSet = new Set(EXPECTED_NPM_PACKAGE_PATHS);
  const missing = EXPECTED_NPM_PACKAGE_PATHS.filter(
    (packagePath) => !actualPathSet.has(packagePath),
  );
  const unexpected = [...actualPathSet]
    .filter((packagePath) => !expectedPathSet.has(packagePath))
    .sort();
  if (missing.length > 0 || unexpected.length > 0) {
    const details = [
      missing.length === 0 ? undefined : `missing: ${missing.join(", ")}`,
      unexpected.length === 0
        ? undefined
        : `unexpected: ${unexpected.join(", ")}`,
    ].filter(Boolean);
    fail(`npm package manifest mismatch (${details.join("; ")})`);
  }

  return { filename, fileCount: actualPaths.length };
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0 && signal === null) resolve(result);
      else {
        reject(
          new Error(
            `${command} failed (${signal ?? `exit ${String(code)}`}): ${result.stderr.trim()}`,
          ),
        );
      }
    });
  });
}

async function smokeInstalledPackage(tarballPath, pkg) {
  const tarball = await realpath(tarballPath);
  const tarballStat = await lstat(tarball);
  if (!tarballStat.isFile()) fail("npm package tarball is not a regular file");

  const smokeRoot = await mkdtemp(path.join(os.tmpdir(), "embassy-pack-smoke-"));
  try {
    await writeFile(
      path.join(smokeRoot, "package.json"),
      `${JSON.stringify({ private: true }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await run(
      process.platform === "win32" ? "npm.cmd" : "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--no-package-lock",
        "--save=false",
        tarball,
      ],
      { cwd: smokeRoot, env: process.env },
    );

    const installedRoot = path.join(smokeRoot, "node_modules", pkg.name);
    for (const modulePath of REQUIRED_ESM_IMPORTS) {
      await import(pathToFileURL(path.join(installedRoot, modulePath)).href);
    }

    for (const binary of ["embassy", "claude-codex-gateway"]) {
      const cliPath = path.join(smokeRoot, "node_modules", ".bin", binary);
      const cli = await run(cliPath, ["--version"], {
        cwd: smokeRoot,
        env: process.env,
      });
      if (cli.stdout !== `embassy ${pkg.version}\n` || cli.stderr !== "") {
        fail(`installed ${binary} CLI returned unexpected version output`);
      }
    }
  } finally {
    await rm(smokeRoot, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === "--print-expected") {
    return { printExpected: true };
  }
  if (argv.length < 2 || argv[0] !== "--report") {
    fail(
      "Usage: check-npm-package.mjs --report REPORT.json [--packed [TARBALL.tgz]]",
    );
  }
  const reportPath = argv[1];
  if (argv.length === 2) return { reportPath, packed: false };
  if (argv.length === 3 && argv[2] === "--packed") {
    return { reportPath, packed: true };
  }
  if (argv.length === 4 && argv[2] === "--packed") {
    return { reportPath, packed: true, tarballPath: argv[3] };
  }
  fail(
    "Usage: check-npm-package.mjs --report REPORT.json [--packed [TARBALL.tgz]]",
  );
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.printExpected === true) {
    process.stdout.write(`${JSON.stringify(EXPECTED_NPM_PACKAGE_PATHS)}\n`);
    return;
  }

  const [pkgText, reportText] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(options.reportPath, "utf8"),
  ]);
  const pkg = JSON.parse(pkgText);
  const reports = JSON.parse(reportText);
  const result = verifyPackageReport(pkg, reports, options.tarballPath);
  process.stdout.write(
    `Verified exact npm package manifest (${result.fileCount} files).\n`,
  );
  if (options.packed === true) {
    await smokeInstalledPackage(options.tarballPath ?? result.filename, pkg);
    process.stdout.write("Verified packed install, ESM graph, and Embassy CLI.\n");
  }
}

if (
  path.resolve(process.argv[1] ?? "") ===
  path.resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Package verification failed"}\n`,
    );
    process.exitCode = 1;
  });
}
