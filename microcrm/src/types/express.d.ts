// Exact bytes of the request body, kept for signature verification.
// A Buffer, not a string: decoding and re-encoding can change the bytes.
declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

export {};
