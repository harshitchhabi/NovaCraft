// Shared diagnostic error types for all compiler stages.

export class CompilerError extends Error {
  constructor(
    public readonly stage: 'Lexical' | 'Syntax' | 'Semantic',
    public readonly line: number,
    public readonly column: number,
    public readonly detail: string,
  ) {
    super(`${stage} error at ${line}:${column} - ${detail}`);
    this.name = `${stage}Error`;
  }
}

export class ErrorReporter {
  private errors: CompilerError[] = [];

  report(err: CompilerError): void {
    this.errors.push(err);
  }

  hasErrors(): boolean {
    return this.errors.length > 0;
  }

  all(): CompilerError[] {
    return this.errors;
  }

  printAll(): void {
    for (const e of this.errors) {
      console.error(e.message);
    }
  }
}
