import { Schema } from "effect";

export class GatewayConfigurationError extends Schema.TaggedError<GatewayConfigurationError>(
  "GatewayConfigurationError",
)("GatewayConfigurationError", {
  message: Schema.String,
}) {}

export class InvalidCommandError extends Schema.TaggedError<InvalidCommandError>(
  "InvalidCommandError",
)("InvalidCommandError", {
  message: Schema.String,
}) {}

export class InvalidRepoSlugError extends Schema.TaggedError<InvalidRepoSlugError>(
  "InvalidRepoSlugError",
)("InvalidRepoSlugError", {
  value: Schema.String,
  message: Schema.String,
}) {}

export class InvalidGithubLoginError extends Schema.TaggedError<InvalidGithubLoginError>(
  "InvalidGithubLoginError",
)("InvalidGithubLoginError", {
  value: Schema.String,
  message: Schema.String,
}) {}

export class FilesystemValidationError extends Schema.TaggedError<FilesystemValidationError>(
  "FilesystemValidationError",
)("FilesystemValidationError", {
  label: Schema.String,
  filePath: Schema.String,
  message: Schema.String,
}) {}

export class HostKeysNotFoundError extends Schema.TaggedError<HostKeysNotFoundError>(
  "HostKeysNotFoundError",
)("HostKeysNotFoundError", {
  checkedPaths: Schema.Array(Schema.String),
  message: Schema.String,
}) {}

export class UserAccountLookupError extends Schema.TaggedError<UserAccountLookupError>(
  "UserAccountLookupError",
)("UserAccountLookupError", {
  username: Schema.String,
  message: Schema.String,
}) {}

type ErrorWithMessage = {
  message: string;
};

function hasMessage(error: unknown): error is ErrorWithMessage {
  return typeof error === "object" && error !== null && "message" in error && typeof error.message === "string";
}

export function formatGatewayError(error: unknown) {
  if (hasMessage(error)) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === "string" ? error : "Unknown gateway error";
}
