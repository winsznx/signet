/**
 * Signet product enhancement.
 *
 * Everything here is optional. The pages render their full meaning with this file absent: the
 * mechanism, the deployment state, the proof summary, the navigation and the attack demo are all
 * static HTML, and the demo runs on radio inputs and CSS rather than on anything below.
 *
 * What this adds is live reading. Three rules govern it:
 *
 *   1. Live data is labelled live and committed evidence is labelled committed. They never blur.
 *   2. A failed live read shows the failure. It never silently falls back to fixture data, because
 *      a fixture wearing a "live" badge is worse than an error message.
 *   3. Wallet state is interface state. It is never evidence, it is never persisted anywhere that
 *      claims to be evidence, and connecting one says nothing about who you are.
 *
 * No framework, no wallet SDK, no bundler. Plain EIP-1193 and fetch, so the CSP can stay at
 * script-src 'self' with a connect-src naming exactly the endpoints the repository already pins.
 */
"use strict";

const COSTON2_CHAIN_ID = 114;
const COSTON2_CHAIN_HEX = "0x72";
const COSTON2_RPC = [
  "https://coston2-api.flare.network/ext/C/rpc",
  "https://rpc.ankr.com/flare_coston2",
  "https://coston2.enosys.global/ext/C/rpc",
];

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Everything user-controlled goes through here before it reaches innerHTML. */
const esc = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const shorten = (v, head = 10, tail = 6) =>
  typeof v === "string" && v.length > head + tail + 3 ? `${v.slice(0, head)}…${v.slice(-tail)}` : String(v);

// ---------------------------------------------------------------- rpc

async function rpcCall(method, params, endpoints = COSTON2_RPC) {
  let lastError = null;
  for (const url of endpoints) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        continue;
      }
      const body = await response.json();
      if (body.error) {
        // A revert is an answer, not a transport failure: hand it back rather than trying the next
        // endpoint, which would only produce the same revert more slowly.
        return { ok: false, revert: body.error, endpoint: url };
      }
      return { ok: true, result: body.result, endpoint: url };
    } catch (error) {
      // A CORS rejection surfaces as a TypeError here, which is exactly the case where trying the
      // next pinned endpoint is the right move rather than giving up.
      lastError = error && error.name === "TimeoutError" ? "timed out" : "unreachable";
    }
  }
  return { ok: false, transport: lastError ?? "unreachable" };
}

// ---------------------------------------------------------------- wallet

const wallet = { address: null, chainId: null, provider: null };

/**
 * Every injected wallet, not just whichever one won the race for window.ethereum.
 *
 * With several extensions installed they all try to occupy that single property, and the loser can
 * end up wrapping or shadowing the winner. The visible symptom is a Connect button that appears to
 * do nothing: a request goes to a provider whose UI never surfaces. EIP-6963 exists precisely for
 * this, so providers are collected by announcement and window.ethereum is only the fallback for a
 * wallet too old to announce itself.
 */
const providers = new Map();

function discoverProviders() {
  window.addEventListener("eip6963:announceProvider", (event) => {
    const { info, provider } = event.detail ?? {};
    if (!info?.uuid || !provider) return;
    providers.set(info.uuid, { name: info.name ?? "Wallet", icon: info.icon ?? null, provider });
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));

  if (window.ethereum && typeof window.ethereum.request === "function") {
    const name = window.ethereum.isMetaMask ? "MetaMask" : "Injected wallet";
    if (![...providers.values()].some((p) => p.provider === window.ethereum)) {
      providers.set("window.ethereum", { name, icon: null, provider: window.ethereum, legacy: true });
    }
  }
}

const COSTON2_PARAMS = {
  chainId: COSTON2_CHAIN_HEX,
  chainName: "Flare Testnet Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: [COSTON2_RPC[0]],
  blockExplorerUrls: ["https://coston2.testnet.flarescan.com"],
};

function walletLabel(button, state, text) {
  button.dataset.state = state;
  button.textContent = text;
  button.setAttribute("aria-live", "polite");
}

async function readChain(provider) {
  const hex = await provider.request({ method: "eth_chainId" });
  return Number.parseInt(hex, 16);
}

function renderWallet(button) {
  if (!wallet.address) return walletLabel(button, "disconnected", "Connect wallet");
  if (wallet.chainId !== COSTON2_CHAIN_ID) return walletLabel(button, "wrong-network", "Switch to Coston2");
  walletLabel(button, "connected", shorten(wallet.address, 6, 4));
}

/** A transient message, so a refusal is never silent. */
function flash(button, text, state = "notice") {
  walletLabel(button, state, text);
  setTimeout(() => renderWallet(button), 2600);
}

/** Ask which wallet, but only when there is genuinely a choice to make. */
async function pickProvider(button) {
  const list = [...providers.entries()].map(([uuid, entry]) => ({ ...entry, uuid }));
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];

  const existing = $("#wallet-picker");
  if (existing) existing.remove();

  const picker = document.createElement("div");
  picker.id = "wallet-picker";
  picker.className = "wallet-picker";
  picker.setAttribute("role", "dialog");
  picker.setAttribute("aria-label", "Choose a wallet");
  picker.innerHTML =
    `<p class="wallet-picker-title">Choose a wallet</p>` +
    list
      .map((p, i) => `<button type="button" class="btn btn-ghost wallet-option" data-index="${i}">${esc(p.name)}</button>`)
      .join("");
  button.parentElement.appendChild(picker);

  return new Promise((resolve) => {
    picker.addEventListener("click", (event) => {
      const option = event.target.closest(".wallet-option");
      if (!option) return;
      picker.remove();
      resolve(list[Number(option.dataset.index)]);
    });
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") {
          picker.remove();
          resolve(null);
        }
      },
      { once: true },
    );
    picker.querySelector(".wallet-option")?.focus();
  });
}

async function switchToCoston2(provider, button) {
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: COSTON2_CHAIN_HEX }] });
  } catch (error) {
    // 4902 means the wallet has never heard of Coston2. Offering to add it is the difference
    // between a working switch and a dead button for anyone who has not added the network by hand.
    if (error && (error.code === 4902 || error.code === -32603)) {
      try {
        await provider.request({ method: "wallet_addEthereumChain", params: [COSTON2_PARAMS] });
      } catch {
        flash(button, "Network not added");
        return false;
      }
    } else {
      flash(button, "Switch declined");
      return false;
    }
  }
  wallet.chainId = await readChain(provider);
  return true;
}

const REMEMBERED = "signet.wallet";

/**
 * Restore an existing connection without prompting.
 *
 * `eth_accounts` returns what the wallet has already authorised for this origin and opens nothing,
 * which is the difference between remembering a session and nagging on every page load. Without
 * this, a reload looked like a disconnect and every navigation asked again. The wallet's own
 * permission is the source of truth; localStorage only records which provider to ask.
 */
async function restoreSession(button) {
  const remembered = (() => {
    try {
      return localStorage.getItem(REMEMBERED);
    } catch {
      return null;
    }
  })();
  const candidates = remembered && providers.has(remembered) ? [providers.get(remembered)] : [...providers.values()];

  for (const entry of candidates) {
    try {
      const accounts = await entry.provider.request({ method: "eth_accounts" });
      if (Array.isArray(accounts) && accounts.length) {
        wallet.address = accounts[0];
        wallet.provider = entry.provider;
        wallet.chainId = await readChain(entry.provider);
        attachProviderEvents(entry.provider, button);
        renderWallet(button);
        broadcast();
        return true;
      }
    } catch {
      /* A provider that will not answer eth_accounts is simply not a restored session. */
    }
  }
  return false;
}

function attachProviderEvents(provider, button) {
  if (provider.__signetBound) return;
  provider.__signetBound = true;
  provider.on?.("accountsChanged", (accounts) => {
    wallet.address = Array.isArray(accounts) && accounts.length ? accounts[0] : null;
    if (!wallet.address) forget();
    renderWallet(button);
    broadcast();
  });
  provider.on?.("chainChanged", (hex) => {
    wallet.chainId = Number.parseInt(hex, 16);
    renderWallet(button);
    broadcast();
  });
}

const remember = (uuid) => {
  try {
    localStorage.setItem(REMEMBERED, uuid);
  } catch {
    /* Private mode. The wallet still holds the permission; only the shortcut is lost. */
  }
};
const forget = () => {
  try {
    localStorage.removeItem(REMEMBERED);
  } catch {
    /* nothing to do */
  }
};

/** Anything on the page that cares about connection state listens for this. */
function broadcast() {
  document.dispatchEvent(
    new CustomEvent("signet:wallet", {
      detail: { address: wallet.address, chainId: wallet.chainId, onCoston2: wallet.chainId === COSTON2_CHAIN_ID },
    }),
  );
}

function initWallet() {
  const button = $("[data-wallet-connect]");
  if (!button) return;
  discoverProviders();

  // Announcements can arrive a tick late, so re-check before deciding there is no wallet at all.
  setTimeout(async () => {
    if (providers.size === 0) return broadcast();
    button.hidden = false;
    renderWallet(button);
    await restoreSession(button);
  }, 150);

  button.addEventListener("click", async () => {
    // Never on load. Only ever from this click.
    if (wallet.address && wallet.chainId !== COSTON2_CHAIN_ID) {
      await switchToCoston2(wallet.provider, button);
      renderWallet(button);
      return;
    }

    const chosen = wallet.provider
      ? { provider: wallet.provider, uuid: null }
      : await pickProvider(button);
    if (!chosen) return renderWallet(button);
    const provider = chosen.provider ?? chosen;

    walletLabel(button, "connecting", "Connecting…");
    try {
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      wallet.address = Array.isArray(accounts) && accounts.length ? accounts[0] : null;
      if (!wallet.address) return flash(button, "No account shared");
      wallet.provider = provider;
      wallet.chainId = await readChain(provider);
      if (chosen.uuid) remember(chosen.uuid);
    } catch (error) {
      wallet.address = null;
      // 4001 is the user declining, which is a normal outcome. Anything else is worth naming, so
      // that "nothing happened" is never the experience.
      flash(button, error?.code === 4001 ? "Connection declined" : "Wallet did not respond");
      return;
    }

    attachProviderEvents(provider, button);
    renderWallet(button);
    broadcast();
  });
}

// ---------------------------------------------------------------- deployment liveness

async function initDeploymentLiveness() {
  const cells = $$("[data-live-code]");
  if (cells.length === 0) return;
  let checked = 0;
  for (const cell of cells) {
    const address = cell.dataset.liveCode;
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) continue;
    cell.innerHTML = '<span class="badge">checking…</span>';
    const answer = await rpcCall("eth_getCode", [address, "latest"]);
    if (!answer.ok) {
      cell.innerHTML = `<span class="badge unavailable">unreachable</span>`;
      continue;
    }
    const bytes = (String(answer.result).length - 2) / 2;
    cell.innerHTML =
      bytes > 0
        ? `<span class="badge verified">live · ${bytes} bytes</span>`
        : `<span class="badge unavailable">no code</span>`;
    checked += 1;
  }
  if (checked > 0) {
    consoleState.deploymentChecked = true;
    renderConsole();
  }
}

// ---------------------------------------------------------------- request inspector

const SELECTORS = {
  // canonicalInstructionFor(uint256,uint32)
  canonicalInstructionFor: "0x011adba4",
};

const FCC_SENDER = () => document.body.dataset.fccSender || "";

function word(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

/** Bounded and validated before it is ever put in a request or on the page. */
function parseRequestId(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!/^[0-9]{1,20}$/.test(trimmed)) return null;
  try {
    const value = BigInt(trimmed);
    if (value < 0n || value > 2n ** 64n - 1n) return null;
    return value;
  } catch {
    return null;
  }
}

const ADAPTER_FAILURE = [
  "NONE",
  "NOT_ACTIVE",
  "WRONG_AGENT",
  "REFERENCE_MISMATCH",
  "AMOUNT_INVALID",
  "DESTINATION_EMPTY",
  "TAG_OUT_OF_RANGE",
  "MODE_UNSUPPORTED",
  "WINDOW_INVALID",
];

function humanRevert(revert) {
  const data = String(revert?.data ?? "");
  if (data.startsWith("0xeed10738")) {
    const code = Number.parseInt(data.slice(10) || "0", 16);
    const name = ADAPTER_FAILURE[code] ?? `code ${code}`;
    if (name === "NOT_ACTIVE") {
      return {
        headline: "This redemption is no longer active.",
        body: "FAssets does not report it ACTIVE, so the contract refuses to build a payment for it. That is the correct answer, not a failure: settled and expired obligations must fail closed.",
        technical: `AdapterRefused(${name}) · ${data}`,
      };
    }
    return {
      headline: "FAssets refused this obligation.",
      body: "The contract read the request and would not produce a canonical instruction for it.",
      technical: `AdapterRefused(${name}) · ${data}`,
    };
  }
  if (data.startsWith("0x4a45b124")) {
    return {
      headline: "No Signet action exists for this request.",
      body: "The obligation was never opened in SignetRegistry, so there is nothing to authorize.",
      technical: `NoSuchAction · ${data}`,
    };
  }
  return {
    headline: "The contract refused this request.",
    body: "It returned a typed refusal rather than a payment, which is the fail-closed path.",
    technical: esc(revert?.message ?? data ?? "reverted"),
  };
}

async function inspect(requestIdRaw, statusEl, resultEl) {
  const requestId = parseRequestId(requestIdRaw);
  resultEl.innerHTML = "";
  if (requestId === null) {
    statusEl.textContent = "Enter a numeric redemption request id.";
    return;
  }
  const sender = FCC_SENDER();
  if (!/^0x[0-9a-fA-F]{40}$/.test(sender)) {
    statusEl.textContent = "No deployed sender is configured in this build.";
    return;
  }

  statusEl.textContent = "Reading the canonical obligation from Coston2…";
  resultEl.innerHTML = '<div class="card tight"><p class="note" style="margin:0">Contacting a pinned Coston2 endpoint…</p></div>';

  const data = `${SELECTORS.canonicalInstructionFor}${word(requestId)}${word(0)}`;
  const answer = await rpcCall("eth_call", [{ to: sender, data }, "latest"]);

  if (answer.transport) {
    statusEl.textContent = "";
    resultEl.innerHTML = `<div class="card tight"><div class="badges"><span class="badge unavailable">Live read unavailable</span></div>
      <p class="note" style="margin:0">No pinned Coston2 endpoint answered (${esc(answer.transport)}). Nothing is substituted from a fixture:
      the committed example below is labelled as committed, and this read simply did not happen.</p></div>`;
    return;
  }

  if (answer.revert) {
    // A typed refusal is a successful inspection: you asked the chain and it answered.
    consoleState.inspected = true;
    renderConsole();
    const human = humanRevert(answer.revert);
    statusEl.textContent = "";
    resultEl.innerHTML = `<div class="card tight">
      <div class="badges"><span class="badge">Live Coston2</span><span class="badge unavailable">Refused</span></div>
      <h4>${esc(human.headline)}</h4>
      <p class="note">${esc(human.body)}</p>
      <details class="row" style="border:1px solid var(--cloud);border-radius:14px;background:var(--paper)">
        <summary style="padding:12px 16px"><span class="title">Technical detail</span></summary>
        <div class="body" style="padding:0 16px 16px"><code>${esc(human.technical)}</code></div>
      </details></div>`;
    return;
  }

  consoleState.inspected = true;
  renderConsole();
  statusEl.textContent = "";
  resultEl.innerHTML = `<div class="card tight">
    <div class="badges"><span class="badge verified">Live Coston2</span><span class="badge">FAssets</span></div>
    <h4>Canonical obligation returned</h4>
    <p class="note">The contract produced an instruction for request ${esc(String(requestId))}. Every payment field in it came
    from FAssets, not from this page.</p>
    <details class="row" style="border:1px solid var(--cloud);border-radius:14px;background:var(--paper)">
      <summary style="padding:12px 16px"><span class="title">Raw return</span></summary>
      <div class="body" style="padding:0 16px 16px"><code class="mono" style="word-break:break-all">${esc(shorten(answer.result, 66, 8))}</code></div>
    </details></div>`;
}

function initInspector() {
  const panel = $("[data-inspector]");
  if (!panel) return;
  panel.hidden = false;
  const statusEl = $("#inspector-status", panel);
  const resultEl = $("#inspector-result", panel);
  const input = $("#request-id", panel);
  const button = $("[data-inspect]", panel);
  button?.addEventListener("click", () => inspect(input.value, statusEl, resultEl));
  input?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") inspect(input.value, statusEl, resultEl);
  });
}

// ---------------------------------------------------------------- operator console

/**
 * The console's job is to answer "what do I do now", continuously.
 *
 * Each step reports its own state, and the first one that is not yet done is marked as the current
 * action. Connecting a wallet has to visibly change something or it feels broken, which is exactly
 * how it felt before: the button went green and the page carried on as if nothing had happened.
 *
 * Read-only is a first-class path, not a fallback. Nothing on this page needs a wallet, and a step
 * list that stalls at "connect" would imply otherwise.
 */
const TOUR_KEY = "signet.tour";
const STEP_ORDER = ["connect", "network", "deployment", "request", "inspect", "observe", "decision", "verify"];

const consoleState = {
  readOnly: false,
  connected: false,
  onCoston2: false,
  deploymentChecked: false,
  requestEntered: false,
  inspected: false,
  observed: false,
  decided: false,
  verified: false,
  cursor: 0,
  skipped: false,
};

const loadTour = () => {
  try {
    return JSON.parse(localStorage.getItem(TOUR_KEY) ?? "{}");
  } catch {
    return {};
  }
};
const saveTour = () => {
  try {
    localStorage.setItem(TOUR_KEY, JSON.stringify({ skipped: consoleState.skipped, cursor: consoleState.cursor }));
  } catch {
    /* private mode: the tour simply does not persist */
  }
};

/** Which steps are satisfied. Read-only counts for the first two, because a wallet is optional. */
function stepDone() {
  return {
    connect: consoleState.connected || consoleState.readOnly,
    network: consoleState.connected ? consoleState.onCoston2 : consoleState.readOnly,
    deployment: consoleState.deploymentChecked,
    request: consoleState.requestEntered,
    inspect: consoleState.inspected,
    observe: consoleState.observed,
    decision: consoleState.decided,
    verify: consoleState.verified,
  };
}

function renderConsole() {
  const rows = $$("[data-step]");
  if (rows.length === 0) return;
  const done = stepDone();

  // The cursor follows the work: the first unfinished step is where you are, unless you have paged
  // ahead with Next, which is a deliberate choice the tour should respect.
  const firstUnfinished = STEP_ORDER.findIndex((key) => !done[key]);
  if (firstUnfinished !== -1 && consoleState.cursor < firstUnfinished) consoleState.cursor = firstUnfinished;
  if (firstUnfinished === -1) consoleState.cursor = STEP_ORDER.length - 1;

  for (const row of rows) {
    const key = row.dataset.step;
    const index = STEP_ORDER.indexOf(key);
    const isDone = done[key] === true;
    const isCurrent = !consoleState.skipped && index === consoleState.cursor && !isDone;
    row.dataset.state = isDone ? "done" : isCurrent ? "current" : "todo";
    const badge = $("[data-step-status]", row);
    if (badge) {
      badge.textContent = isDone ? "Done" : isCurrent ? "Do this next" : "Waiting";
      badge.className = `badge ${isDone ? "verified" : isCurrent ? "simulated" : ""}`;
    }
  }

  const nav = $("[data-tour-nav]");
  if (nav) {
    nav.hidden = consoleState.skipped;
    const position = $("[data-tour-position]");
    if (position) position.textContent = `Step ${consoleState.cursor + 1} of ${STEP_ORDER.length}`;
    const prev = $("[data-tour-prev]");
    const next = $("[data-tour-next]");
    if (prev) prev.disabled = consoleState.cursor === 0;
    if (next) next.disabled = consoleState.cursor >= STEP_ORDER.length - 1;
  }
  const skip = $("[data-tour-skip]");
  const restart = $("[data-tour-restart]");
  if (skip) skip.hidden = consoleState.skipped;
  if (restart) restart.hidden = !consoleState.skipped;

  const summary = $("#console-summary");
  if (summary) {
    const doneCount = STEP_ORDER.filter((k) => done[k]).length;
    if (consoleState.skipped) {
      summary.innerHTML = `<span class="badge">Tour skipped</span> Everything below still works. Restart the tour any time.`;
    } else if (consoleState.connected && consoleState.onCoston2) {
      summary.innerHTML = `<span class="badge verified">Connected &middot; Coston2</span> ${doneCount} of ${STEP_ORDER.length} done. Inspect any redemption below; nothing signs.`;
    } else if (consoleState.connected) {
      summary.innerHTML = `<span class="badge simulated">Wrong network</span> Switch to Coston2 from the header. Everything below still works read-only.`;
    } else if (consoleState.readOnly) {
      summary.innerHTML = `<span class="badge">Read-only</span> ${doneCount} of ${STEP_ORDER.length} done. No wallet needed for anything here.`;
    } else {
      summary.innerHTML = `<span class="badge">Start here</span> Connect a wallet, or continue read-only. A wallet is optional and never implies you operate a FAssets agent.`;
    }
  }
}

function initConsole() {
  if ($$("[data-step]").length === 0) return;

  const saved = loadTour();
  consoleState.skipped = saved.skipped === true;
  consoleState.cursor = Number.isInteger(saved.cursor) ? Math.min(saved.cursor, STEP_ORDER.length - 1) : 0;

  $("[data-read-only]")?.addEventListener("click", () => {
    consoleState.readOnly = true;
    renderConsole();
    $("#inspector-panel")?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  $("[data-tour-prev]")?.addEventListener("click", () => {
    consoleState.cursor = Math.max(0, consoleState.cursor - 1);
    saveTour();
    renderConsole();
  });
  $("[data-tour-next]")?.addEventListener("click", () => {
    consoleState.cursor = Math.min(STEP_ORDER.length - 1, consoleState.cursor + 1);
    saveTour();
    renderConsole();
  });
  $("[data-tour-skip]")?.addEventListener("click", () => {
    consoleState.skipped = true;
    saveTour();
    renderConsole();
  });
  $("[data-tour-restart]")?.addEventListener("click", () => {
    consoleState.skipped = false;
    consoleState.cursor = 0;
    saveTour();
    renderConsole();
    $("#onboarding")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  document.addEventListener("signet:wallet", (event) => {
    consoleState.connected = Boolean(event.detail.address);
    consoleState.onCoston2 = event.detail.onCoston2 === true;
    renderConsole();
  });

  $("#request-id")?.addEventListener("input", () => {
    consoleState.requestEntered = true;
    renderConsole();
  });
  for (const node of $$("[data-decision]")) {
    node.addEventListener("toggle", () => {
      if (!node.open) return;
      consoleState.decided = true;
      renderConsole();
    });
  }
  // The last step is reading the evidence, so reaching the evidence links is what completes it.
  for (const link of $$('a[href^="/proof"]')) {
    link.addEventListener("click", () => {
      consoleState.verified = true;
      saveTour();
    });
  }

  renderConsole();
}

// ---------------------------------------------------------------- xrpl observation

const XRPL_ENDPOINTS = ["https://s.altnet.rippletest.net:51234", "https://testnet.xrpl-labs.com"];

/**
 * Ask every endpoint, not the first one that answers.
 *
 * The observer this mirrors refuses to treat one node's silence as absence, and it would be a
 * strange thing to relax in the surface that explains it. Disagreement is shown as disagreement:
 * it is a real reason code, not an error to smooth over.
 */
async function observeLedger(txHash) {
  const answers = await Promise.all(
    XRPL_ENDPOINTS.map(async (endpoint) => {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ method: "tx", params: [{ transaction: txHash }] }),
          signal: AbortSignal.timeout(12000),
        });
        const body = await response.json();
        if (body?.result && !body.result.error) {
          return { endpoint, found: true, result: body.result.meta?.TransactionResult, ledger: body.result.ledger_index };
        }
        return { endpoint, found: false, why: body?.result?.error ?? "no answer" };
      } catch (error) {
        return { endpoint, found: false, why: error?.name === "TimeoutError" ? "timed out" : "unreachable" };
      }
    }),
  );
  return answers;
}

function initObserve() {
  const panel = $("[data-observe]");
  if (!panel) return;
  panel.hidden = false;
  const statusEl = $("#observe-status");
  const resultEl = $("#observe-result");
  const txHash = document.body.dataset.demoTx ?? "";

  $("[data-observe-run]", panel)?.addEventListener("click", async () => {
    if (!/^[0-9A-Fa-f]{64}$/.test(txHash)) {
      statusEl.textContent = "No example transaction is configured in this build.";
      return;
    }
    statusEl.textContent = "Asking both XRPL endpoints…";
    resultEl.innerHTML = `<div class="card tight"><p class="note" style="margin:0">Two independent endpoints, in parallel…</p></div>`;

    const answers = await observeLedger(txHash);
    const found = answers.filter((a) => a.found);
    consoleState.observed = true;
    renderConsole();
    statusEl.textContent = "";

    const rows = answers
      .map(
        (a) => `<div class="derived-field">
          <span class="derived-label">${esc(new URL(a.endpoint).host)}</span>
          <span class="derived-value">${a.found ? `found &middot; ${esc(a.result ?? "validated")} &middot; ledger ${esc(a.ledger ?? "?")}` : `no answer &middot; ${esc(a.why)}`}</span>
          <span class="badge ${a.found ? "verified" : "unavailable"}">${a.found ? "XRPL" : "unavailable"}</span>
        </div>`,
      )
      .join("");

    let verdict;
    if (found.length === 0) {
      verdict = `<p class="outcome-head refused">No endpoint could answer</p><p class="note" style="margin:0">Signet refuses here rather than guessing: this is <code>S022_UNDERLYING_STATE_UNAVAILABLE</code>. An observation nobody could make is not an observation.</p>`;
    } else if (found.length === 1) {
      verdict = `<p class="outcome-head refused">Only one endpoint answered</p><p class="note" style="margin:0">One source is not agreement. A node that has pruned the ledger cannot testify to absence, so this counts as too few sources: <code>S022_UNDERLYING_STATE_UNAVAILABLE</code>.</p>`;
    } else if (new Set(found.map((a) => a.result)).size > 1) {
      verdict = `<p class="outcome-head refused">Endpoints disagree</p><p class="note" style="margin:0">Fails closed as <code>S023_UNDERLYING_STATE_DISAGREEMENT</code>, and deliberately never retried automatically.</p>`;
    } else {
      verdict = `<p class="outcome-head impossible">Both endpoints agree</p><p class="note" style="margin:0">The payment exists and is validated. For a fresh obligation this is what a prior payment would look like, and the decision would refuse with <code>S021_PAYMENT_ALREADY_OBSERVED</code> rather than paying twice.</p>`;
    }

    resultEl.innerHTML = `<div class="card tight"><div class="derived">${rows}</div><div class="outcome">${verdict}</div></div>`;
  });
}

// ---------------------------------------------------------------- copy buttons

function toast(message) {
  const existing = $(".toast");
  if (existing) existing.remove();
  const node = document.createElement("div");
  node.className = "toast";
  node.setAttribute("role", "status");
  node.textContent = message;
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 2200);
}

function initCopy() {
  for (const node of $$("[data-copy]")) {
    node.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(node.dataset.copy ?? "");
        const previous = node.textContent;
        node.textContent = "Copied";
        toast("Copied to clipboard");
        setTimeout(() => {
          node.textContent = previous;
        }, 1400);
      } catch {
        // Clipboard permission is commonly denied and the text is visible anyway, so say what to do
        // rather than failing silently.
        toast("Copy blocked by the browser. Select the text instead.");
      }
    });
  }
}

// ---------------------------------------------------------------- boot

function boot() {
  initWallet();
  initConsole();
  initObserve();
  initCopy();
  initInspector();
  initDeploymentLiveness();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
