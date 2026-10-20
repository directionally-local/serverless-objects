// The `cloudflare:email` module for apps run by the native engine. Messages
// can be constructed, but there is no email binding to send them with yet.
export class EmailMessage {
  constructor(from, to, raw) {
    this.from = from;
    this.to = to;
    this.raw = raw;
  }
}
