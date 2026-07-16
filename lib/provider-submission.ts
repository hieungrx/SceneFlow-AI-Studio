export class ProviderSubmissionError extends Error {
  readonly errorCode: "provider_submission_rejected" | "provider_submission_uncertain";
  readonly ambiguous: boolean;

  constructor(
    message: string,
    errorCode: "provider_submission_rejected" | "provider_submission_uncertain",
    ambiguous: boolean,
  ) {
    super(message);
    this.name = "ProviderSubmissionError";
    this.errorCode = errorCode;
    this.ambiguous = ambiguous;
  }
}
