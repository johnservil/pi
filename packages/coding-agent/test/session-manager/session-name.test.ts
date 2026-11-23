import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

describe("SessionManager.getSessionName", () => {
	it("follows the latest session_info entry as entries are appended", () => {
		const session = SessionManager.inMemory();
		expect(session.getSessionName()).toBeUndefined();

		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		expect(session.getSessionName()).toBeUndefined();

		session.appendSessionInfo("first");
		expect(session.getSessionName()).toBe("first");

		session.appendMessage({ role: "user", content: "again", timestamp: 2 });
		expect(session.getSessionName()).toBe("first");

		session.appendSessionInfo("  second  ");
		expect(session.getSessionName()).toBe("second");

		// An empty name clears the title.
		session.appendSessionInfo("");
		expect(session.getSessionName()).toBeUndefined();
	});

	it("reads the entries again when the session is rebuilt", () => {
		const session = SessionManager.inMemory();
		const firstId = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendSessionInfo("named later");
		expect(session.getSessionName()).toBe("named later");

		// The path to the first message does not hold the name.
		session.createBranchedSession(firstId);
		expect(session.getSessionName()).toBeUndefined();

		session.appendSessionInfo("branch");
		expect(session.getSessionName()).toBe("branch");

		session.newSession();
		expect(session.getSessionName()).toBeUndefined();
	});

	it("does not read the whole session again on every call", () => {
		const session = SessionManager.inMemory();
		for (let index = 0; index < 50; index++) {
			session.appendMessage({ role: "user", content: `message ${index}`, timestamp: index });
		}
		expect(session.getSessionName()).toBeUndefined();

		// Count every later look at the type of an entry that has already been read.
		let reads = 0;
		for (const entry of session.getEntries()) {
			const type = entry.type;
			Object.defineProperty(entry, "type", {
				get() {
					reads++;
					return type;
				},
			});
		}
		reads = 0;

		// The footer asks on every frame.
		for (let frame = 0; frame < 10; frame++) {
			expect(session.getSessionName()).toBeUndefined();
		}
		session.appendSessionInfo("named");
		expect(session.getSessionName()).toBe("named");
		expect(reads).toBe(0);
	});
});
