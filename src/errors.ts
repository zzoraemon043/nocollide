export class NocollideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NocollideError";
  }
}
