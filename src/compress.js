import zlib from "node:zlib";

const COMPRESSIBLE =
  /^(text\/|application\/(json|javascript|manifest\+json|xml)|image\/svg\+xml)/i;
const MIN_BYTES = 1024;

// Gzip text responses (HTML, JS, CSS, JSON, SVG) when the browser accepts it.
// Built on node:zlib so the app needs no extra dependency.
export function compress() {
  return (req, res, next) => {
    res.vary("Accept-Encoding");
    if (req.method === "HEAD" || req.headers.range) return next();
    if (!/\bgzip\b/i.test(req.headers["accept-encoding"] || "")) return next();

    const write = res.write.bind(res);
    const end = res.end.bind(res);
    let gzip = null;
    let decided = false;

    function decide() {
      decided = true;
      const type = res.getHeader("Content-Type");
      const length = Number(res.getHeader("Content-Length"));
      const skip =
        res.getHeader("Content-Encoding") ||
        res.statusCode === 204 ||
        res.statusCode === 304 ||
        !type ||
        !COMPRESSIBLE.test(String(type)) ||
        (Number.isFinite(length) && length < MIN_BYTES);
      if (skip) return;
      gzip = zlib.createGzip({ level: 6 });
      gzip.on("data", (chunk) => write(chunk));
      gzip.on("end", () => end());
      res.setHeader("Content-Encoding", "gzip");
      res.removeHeader("Content-Length");
    }

    res.write = (chunk, encoding, callback) => {
      if (!decided) decide();
      if (!gzip) return write(chunk, encoding, callback);
      return gzip.write(chunk, encoding, callback);
    };
    res.end = (chunk, encoding, callback) => {
      if (typeof chunk === "function") {
        callback = chunk;
        chunk = undefined;
      }
      if (!decided) decide();
      if (!gzip) return end(chunk, encoding, callback);
      if (callback) res.once("finish", callback);
      if (chunk) gzip.end(chunk, encoding);
      else gzip.end();
      return res;
    };
    next();
  };
}
