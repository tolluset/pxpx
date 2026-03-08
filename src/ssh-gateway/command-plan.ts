import {
  InvalidCommandError,
  InvalidGithubLoginError,
  InvalidRepoSlugError,
} from "./errors";
import type { CommandPlan } from "./types";

export const REPO_SLUG_PATTERN = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i;
export const GITHUB_LOGIN_PATTERN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
export const ALLOWED_ACCESS_ACTIONS = new Set(["status", "enable", "disable", "grant", "revoke"]);

export function sanitizeGithubLogin(value: string) {
  const normalized = value.trim().replace(/^@/, "").toLowerCase();

  if (!GITHUB_LOGIN_PATTERN.test(normalized)) {
    throw new InvalidGithubLoginError({
      value,
      message: "github-login must be a valid GitHub handle",
    });
  }

  return normalized;
}

export function sanitizeRepoSlug(value: string) {
  const normalized = value
    .trim()
    .replace(/^@/, "")
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^ssh:\/\/git@github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/^github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();

  if (!REPO_SLUG_PATTERN.test(normalized)) {
    throw new InvalidRepoSlugError({
      value,
      message: "repository selector must use owner/repo format",
    });
  }

  return normalized;
}

export function tokenizeCommand(command: string) {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if ((char === "'" || char === '"') && !quote) {
      quote = char;
      continue;
    }

    if (quote && char === quote) {
      quote = null;
      continue;
    }

    if (!quote && /\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaped || quote) {
    throw new InvalidCommandError({
      message: "command contains an unterminated escape or quote",
    });
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

export function resolveCommandPlan(command?: string): CommandPlan {
  if (!command || command.trim().length === 0) {
    return {
      args: [],
      interactive: true,
    };
  }

  const tokens = tokenizeCommand(command);

  if (tokens.length === 0) {
    return {
      args: [],
      interactive: true,
    };
  }

  if (tokens.length === 1 && (tokens[0] === "-h" || tokens[0] === "--help")) {
    return {
      args: tokens,
      interactive: false,
    };
  }

  if (tokens.length === 1 && REPO_SLUG_PATTERN.test(tokens[0])) {
    return {
      args: [sanitizeRepoSlug(tokens[0])],
      interactive: true,
    };
  }

  if (tokens.length === 1 && (tokens[0] === "login" || tokens[0] === "logout" || tokens[0] === "whoami")) {
    return {
      args: tokens,
      interactive: false,
    };
  }

  if (tokens[0] !== "access") {
    throw new InvalidCommandError({
      message: "unsupported command. Use an empty command, owner/repo, login, logout, whoami, or access.",
    });
  }

  const action = tokens[1];

  if (!action || !ALLOWED_ACCESS_ACTIONS.has(action)) {
    throw new InvalidCommandError({
      message: "access requires one of: status, enable, disable, grant, revoke",
    });
  }

  if (!tokens[2]) {
    throw new InvalidCommandError({
      message: "access requires owner/repo",
    });
  }

  const args = ["access", action, sanitizeRepoSlug(tokens[2])];

  if (action === "grant" || action === "revoke") {
    if (!tokens[3]) {
      throw new InvalidCommandError({
        message: `${action} requires a GitHub login`,
      });
    }

    args.push(sanitizeGithubLogin(tokens[3]));

    if (tokens.length > 4) {
      throw new InvalidCommandError({
        message: "unexpected extra arguments",
      });
    }
  } else if (tokens.length > 3) {
    throw new InvalidCommandError({
      message: "unexpected extra arguments",
    });
  }

  return {
    args,
    interactive: false,
  };
}
