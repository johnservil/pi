import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatBuildTag } from "../src/config.ts";
import {
	collectVersionInfo,
	discoverExtensionFiles,
	extractDeclaredVersion,
	formatVersionInfoPlain,
	formatVersionInfoThemed,
} from "../src/core/version-info.ts";
import { createHarness } from "./suite/harness.ts";

describe("version-info", () => {
	const tempDirs: string[] = [];

	function makeTempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-version-info-"));
		tempDirs.push(dir);
		return dir;
	}

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("formats fork build tags cleanly", () => {
		expect(
			formatBuildTag({
				fork: "johnservil/pi",
				commit: "1f0ac0a1234567890abcdef1234567890abcdef1",
				commitShort: "1f0ac0a",
				commitDate: "2026-11-23T08:09:00Z",
				commitSubject: "test",
				dirty: false,
				builtAt: "2026-11-23T08:10:00Z",
			}),
		).toBe("johnservil/pi @ 1f0ac0a");

		expect(
			formatBuildTag({
				fork: "johnservil/pi",
				commit: "1f0ac0a1234567890abcdef1234567890abcdef1",
				commitShort: "1f0ac0a",
				commitDate: "",
				commitSubject: "",
				dirty: true,
				builtAt: "",
			}),
		).toBe("johnservil/pi @ 1f0ac0a-dirty");

		expect(
			formatBuildTag({
				fork: "",
				commit: "",
				commitShort: "",
				commitDate: "",
				commitSubject: "",
				dirty: false,
				builtAt: "",
			}),
		).toBe("");
	});

	it("extracts explicit version annotations from plugin headers", () => {
		expect(extractDeclaredVersion("// Version: 2026-11-24.1\nexport default function() {}")).toBe("2026-11-24.1");
		expect(extractDeclaredVersion("/**\n * @version 1.2.3-rc1\n */")).toBe("1.2.3-rc1");
		expect(extractDeclaredVersion('export const VERSION = "0.9.4";')).toBe("0.9.4");
		expect(extractDeclaredVersion("// plain comment without version")).toBeUndefined();
	});

	it("collects plugin sha256, declared version, package version, and load errors", () => {
		const root = makeTempDir();
		const agentDir = join(root, "agent");
		const extDir = join(agentDir, "extensions");
		const pkgDir = join(agentDir, "npm", "node_modules", "@example", "my-plugin");
		mkdirSync(extDir, { recursive: true });
		mkdirSync(pkgDir, { recursive: true });

		const standalone = join(extDir, "clock-timestamps.ts");
		writeFileSync(standalone, "// Version: 2026-11-24.1\nexport default function () {}\n");

		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@example/my-plugin", version: "2.4.0" }));
		const pkgEntry = join(pkgDir, "index.js");
		writeFileSync(pkgEntry, "export default function () {}\n");

		const report = collectVersionInfo({
			version: "1.6.0",
			buildInfo: {
				fork: "johnservil/pi",
				commit: "abcdef1234567890abcdef1234567890abcdef12",
				commitShort: "abcdef1",
				commitDate: "2026-11-24T18:30:00Z",
				commitSubject: "feat: add /version command",
				dirty: false,
				builtAt: "2026-11-24T18:31:00Z",
			},
			entryPath: "/tmp/pi/cli.js",
			agentDir,
			cwd: root,
			extensions: [
				{
					path: standalone,
					resolvedPath: standalone,
					sourceInfo: { path: standalone, source: "local", scope: "user", origin: "top-level" },
				},
				{
					path: pkgEntry,
					resolvedPath: pkgEntry,
					sourceInfo: {
						path: pkgEntry,
						source: "npm:@example/my-plugin",
						scope: "user",
						origin: "package",
						baseDir: pkgDir,
					},
				},
			],
			extensionErrors: [{ path: "/tmp/broken.ts", error: "syntax error" }],
			globalPackages: ["npm:@example/my-plugin"],
			skillCount: 3,
			themeCount: 2,
			promptCount: 1,
		});

		expect(report.buildTag).toBe("johnservil/pi @ abcdef1");
		expect(report.plugins).toHaveLength(2);
		expect(report.plugins[0]?.declaredVersion).toBe("2026-11-24.1");
		expect(report.plugins[0]?.sha256).toMatch(/^[0-9a-f]{12}$/);
		expect(report.plugins[1]?.packageName).toBe("@example/my-plugin");
		expect(report.plugins[1]?.packageVersion).toBe("2.4.0");
		expect(report.packages[0]?.installedVersion).toBe("2.4.0");

		const plain = formatVersionInfoPlain(report);
		expect(plain).toContain("Pi v1.6.0 (johnservil/pi @ abcdef1)");
		expect(plain).toContain("clock-timestamps.ts");
		expect(plain).toContain("v2026-11-24.1");
		expect(plain).toContain("@example/my-plugin@2.4.0");
		expect(plain).toContain("Extension Load Errors (1)");

		const themed = formatVersionInfoThemed(report, { bold: (t) => t, fg: (_c, t) => t });
		expect(themed).toContain("Pi v1.6.0 (johnservil/pi @ abcdef1)");
		expect(themed).toContain("Resources: 2 themes, 3 skills, 1 prompt templates");

		const discovered = discoverExtensionFiles(agentDir, root);
		expect(discovered.map((e) => e.path)).toEqual([standalone]);
	});

	it("caches AgentSession.getContextUsage() across repeated calls until session changes", async () => {
		const { session, cleanup } = await createHarness();
		try {
			const spy = vi.spyOn(session.sessionManager, "buildSessionProjection");
			const first = session.getContextUsage();
			for (let i = 0; i < 50; i++) {
				expect(session.getContextUsage()).toEqual(first);
			}
			expect(spy).toHaveBeenCalledTimes(1);

			// Appending a new message invalidates the cache on the next call.
			session.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "hello world" }],
				timestamp: Date.now(),
			});
			const second = session.getContextUsage();
			expect(spy).toHaveBeenCalledTimes(2);
			expect(second).toBeDefined();
			expect(session.getContextUsage()).toEqual(second);
			expect(spy).toHaveBeenCalledTimes(2);
		} finally {
			cleanup();
		}
	});
});
