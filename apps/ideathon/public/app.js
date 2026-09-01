let credential = "";
const $ = (id) => document.getElementById(id);

function showError(message) { $("error").textContent = message || ""; }
function short(value, length = 38) { return value?.length > length ? `${value.slice(0, length)}…` : value || ""; }

const config = await fetch("/api/config").then((r) => r.json());
if (!config.googleClientId) showError("Deployment is missing GOOGLE_CLIENT_ID.");
else {
  const load = setInterval(() => {
    if (!window.google?.accounts?.id) return;
    clearInterval(load);
    google.accounts.id.initialize({ client_id: config.googleClientId, callback: ({ credential: value }) => {
      credential = value;
      const segment = value.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const payload = JSON.parse(atob(segment.padEnd(Math.ceil(segment.length / 4) * 4, "=")));
      $("identity").textContent = `Signed in as ${payload.name || payload.email}`;
      $("evaluate").disabled = false;
      showError("");
    }});
    google.accounts.id.renderButton($("google-button"), { theme: "outline", size: "large", shape: "pill" });
  }, 50);
}

document.querySelectorAll("[data-example]").forEach((button) => button.addEventListener("click", () => { $("intent").value = button.dataset.example; }));
$("evaluate").addEventListener("click", async () => {
  $("evaluate").disabled = true; showError(""); $("result").classList.add("hidden");
  try {
    const response = await fetch("/api/evaluate", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${credential}` }, body: JSON.stringify({ intent: $("intent").value }) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Evaluation failed");
    const allowed = body.decision === "allow";
    $("result").className = `result ${allowed ? "allowed" : "denied"}`;
    $("badge").textContent = allowed ? "✓ ALLOWED" : "× BLOCKED";
    $("decision").textContent = allowed ? "This action may proceed." : "Custos stopped this action.";
    $("reason").textContent = body.reason;
    $("tool").textContent = body.plan.tool;
    $("args").textContent = JSON.stringify(body.plan.args, null, 2);
    $("rule").textContent = body.rule;
    $("verified").textContent = `${body.ledger.records} record(s) · ${body.ledger.verified ? "signature chain verified" : "verification failed"}`;
    $("hash").textContent = short(body.receipt.hash, 62);
    $("signature").textContent = short(body.receipt.signature, 62);
  } catch (error) { showError(error.message); }
  finally { $("evaluate").disabled = !credential; }
});
