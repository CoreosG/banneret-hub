// Loaded before the shipped Node entry. Record attempts before DNS, including failed ones.
const fs = require("node:fs");
const net = require("node:net");
const diagnostics = require("node:diagnostics_channel");

const log = (endpoint) =>
  fs.appendFileSync(process.env.EGRESS_LOG, JSON.stringify(endpoint) + "\n");
diagnostics.channel("undici:request:create").subscribe(({ request }) => {
  const url = new URL(request.path, request.origin);
  log(url.origin + url.pathname);
});
diagnostics.channel("http.client.request.start").subscribe(({ request }) => {
  const url = new URL(request.path, request.protocol + "//" + request.host);
  log(url.origin + url.pathname);
});
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const [options] = Array.isArray(args[0]) ? args[0] : net._normalizeArgs(args);
  if (!options.path) {
    const host = options.host || "localhost";
    log("tcp://" + (host.includes(":") && !host.startsWith("[") ? "[" + host + "]" : host));
    if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
      throw new Error("Offline egress test intercepted " + host);
    }
  }
  return connect.apply(this, args);
};
