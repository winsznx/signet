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
  const list = [...providers.values()];
  if (list.length === 0) return null;
  if (list.length === 1) return list[0].provider;

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
      resolve(list[Number(option.dataset.index)].provider);
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

function initWallet() {
  const button = $("[data-wallet-connect]");
  if (!button) return;
  discoverProviders();

  // Announcements can arrive a tick late, so re-check before deciding there is no wallet at all.
  setTimeout(() => {
    if (providers.size === 0) return;
    button.hidden = false;
    renderWallet(button);
  }, 120);

  button.addEventListener("click", async () => {
    // Never on load. Only ever from this click.
    if (wallet.address && wallet.chainId !== COSTON2_CHAIN_ID) {
      await switchToCoston2(wallet.provider, button);
      renderWallet(button);
      return;
    }

    const provider = wallet.provider ?? (await pickProvider(button));
    if (!provider) return renderWallet(button);

    walletLabel(button, "connecting", "Connecting…");
    try {
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      wallet.address = Array.isArray(accounts) && accounts.length ? accounts[0] : null;
      if (!wallet.address) return flash(button, "No account shared");
      wallet.provider = provider;
      wallet.chainId = await readChain(provider);
    } catch (error) {
      wallet.address = null;
      // 4001 is the user declining, which is a normal outcome. Anything else is worth naming, so
      // that "nothing happened" is never the experience.
      flash(button, error?.code === 4001 ? "Connection declined" : "Wallet did not respond");
      return;
    }

    provider.on?.("accountsChanged", (accounts) => {
      wallet.address = Array.isArray(accounts) && accounts.length ? accounts[0] : null;
      renderWallet(button);
    });
    provider.on?.("chainChanged", (hex) => {
      wallet.chainId = Number.parseInt(hex, 16);
      renderWallet(button);
    });

    renderWallet(button);
  });
}

// ---------------------------------------------------------------- deployment liveness

async function initDeploymentLiveness() {
  const cells = $$("[data-live-code]");
  if (cells.length === 0) return;
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

// ---------------------------------------------------------------- copy buttons

function initCopy() {
  for (const node of $$("[data-copy]")) {
    node.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(node.dataset.copy ?? "");
        const previous = node.textContent;
        node.textContent = "Copied";
        setTimeout(() => {
          node.textContent = previous;
        }, 1400);
      } catch {
        /* Clipboard denied is not worth an error state; the text is visible anyway. */
      }
    });
  }
}

// ---------------------------------------------------------------- boot

function boot() {
  initWallet();
  initCopy();
  initInspector();
  initDeploymentLiveness();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
