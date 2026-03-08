import { describe, expect, test } from "bun:test";
import {
  resolveCommandPlan,
  sanitizeGithubLogin,
  sanitizeRepoSlug,
  tokenizeCommand,
} from "../../src/ssh-gateway/command-plan";
import {
  InvalidCommandError,
  InvalidGithubLoginError,
  InvalidRepoSlugError,
} from "../../src/ssh-gateway/errors";

describe("sanitizeRepoSlug", () => {
  test("normalizes GitHub https URLs", () => {
    expect(sanitizeRepoSlug("https://github.com/Facebook/React.git")).toBe("facebook/react");
  });

  test("normalizes git ssh URLs", () => {
    expect(sanitizeRepoSlug("git@github.com:OpenAI/openai-node.git")).toBe("openai/openai-node");
  });

  test("rejects invalid repo selectors", () => {
    expect(() => sanitizeRepoSlug("not-a-repo")).toThrow(InvalidRepoSlugError);
  });
});

describe("sanitizeGithubLogin", () => {
  test("normalizes leading at-signs", () => {
    expect(sanitizeGithubLogin("@BHKKU")).toBe("bhkku");
  });

  test("rejects invalid handles", () => {
    expect(() => sanitizeGithubLogin("bad handle")).toThrow(InvalidGithubLoginError);
  });
});

describe("tokenizeCommand", () => {
  test("preserves quoted arguments", () => {
    expect(tokenizeCommand("access grant owner/repo \"Test-User\"")).toEqual([
      "access",
      "grant",
      "owner/repo",
      "Test-User",
    ]);
  });

  test("rejects unterminated quotes", () => {
    expect(() => tokenizeCommand("\"unterminated")).toThrow(InvalidCommandError);
  });
});

describe("resolveCommandPlan", () => {
  test("defaults to an interactive session for empty commands", () => {
    expect(resolveCommandPlan()).toEqual({
      args: [],
      interactive: true,
    });
  });

  test("maps repo commands to interactive room joins", () => {
    expect(resolveCommandPlan("facebook/react")).toEqual({
      args: ["facebook/react"],
      interactive: true,
    });
  });

  test("supports plain auth commands", () => {
    expect(resolveCommandPlan("login")).toEqual({
      args: ["login"],
      interactive: false,
    });
  });

  test("supports access grant commands", () => {
    expect(resolveCommandPlan("access grant vercel/next.js @OpenAI")).toEqual({
      args: ["access", "grant", "vercel/next.js", "openai"],
      interactive: false,
    });
  });

  test("rejects unsupported commands", () => {
    expect(() => resolveCommandPlan("rm -rf /")).toThrow(InvalidCommandError);
  });
});
