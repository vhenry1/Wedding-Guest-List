/*
 * Wedding Guest List tracker
 * Accounts use Neon Auth; households live in Neon Postgres behind the guestapi Function.
 */
import { createAuthClient } from "./vendor/neon-auth.js";
import { AUTH_URL, API_URL } from "./config.js";

const auth = createAuthClient(AUTH_URL);

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let currentUser = null;   // { email, couple, date }
let households = [];
let editingId = null;

// ---------- API ----------
// The SDK puts the short-lived JWT on session.token and caches/refreshes it for us.
async function getToken() {
  const { data } = await auth.getSession();
  const token = data?.session?.token;
  if (!token) throw new Error("Your session has expired. Please log in again.");
  return token;
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(API_URL + path, {
    method,
    headers: {
      Authorization: `Bearer ${await getToken()}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    throw new Error("Your session has expired. Please log in again.");
  }
  if (!res.ok) throw new Error(data.error || "Something went wrong. Please try again.");
  return data;
}

// ---------- Feedback ----------
let toastTimer;
function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 5000);
}

// Disable a submit button and show a working label while a request runs
async function busy(button, label, work) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    return await work();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

// ---------- Auth ----------
function showAuth() {
  $("#loading-view").hidden = true;
  $("#app-view").hidden = true;
  $("#auth-view").hidden = false;
}

async function showApp() {
  $("#loading-view").hidden = false;
  $("#auth-view").hidden = true;
  let profile, list;
  try {
    [profile, list] = await Promise.all([api("/api/profile"), api("/api/households")]);
  } catch (ex) {
    showAuth(); // put the form back so the caller can show the error
    throw ex;
  }
  currentUser.couple = profile.couple || currentUser.couple;
  currentUser.date = profile.date || "";
  households = list;
  $("#couple-name").textContent = currentUser.couple || "Our Wedding";
  $("#countdown").textContent = countdownText(currentUser.date);
  $("#loading-view").hidden = true;
  $("#app-view").hidden = false;
  render();
}

function countdownText(date) {
  if (!date) return currentUser.email;
  const target = new Date(date + "T00:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((target - today) / 86400000);
  const pretty = target.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
  if (days > 0) return `${pretty} · ${days} day${days === 1 ? "" : "s"} to go`;
  if (days === 0) return `${pretty} · Today's the day!`;
  return pretty;
}

function switchTab(tab) {
  $$(".tab").forEach((t) => {
    const active = t.dataset.tab === tab;
    t.classList.toggle("is-active", active);
    t.setAttribute("aria-selected", active);
  });
  $("#login-form").hidden = tab !== "login";
  $("#signup-form").hidden = tab !== "signup";
  $$(".auth .form-error").forEach((e) => (e.textContent = ""));
}

const authMessage = (error, fallback) => error?.message || error?.statusText || fallback;

async function handleSignup(e) {
  e.preventDefault();
  const form = e.target;
  const err = $(".form-error", form);
  const couple = form.couple.value.trim();
  const email = form.email.value.trim().toLowerCase();
  const password = form.password.value;
  const date = form.date.value;
  err.textContent = "";

  if (!couple) return (err.textContent = "Please enter your names.");
  if (!/^\S+@\S+\.\S+$/.test(email)) return (err.textContent = "Please enter a valid email.");
  if (password.length < 8) return (err.textContent = "Password must be at least 8 characters.");

  await busy($("button[type=submit]", form), "Creating account…", async () => {
    try {
      const { data, error } = await auth.signUp.email({ email, password, name: couple });
      if (error) return (err.textContent = authMessage(error, "Couldn't create your account."));
      currentUser = { email, couple, date };
      await api("/api/profile", { method: "PUT", body: { couple, date } });
      form.reset();
      await showApp();
    } catch (ex) {
      err.textContent = ex.message;
    }
  });
}

async function handleLogin(e) {
  e.preventDefault();
  const form = e.target;
  const err = $(".form-error", form);
  err.textContent = "";
  const email = form.email.value.trim().toLowerCase();

  await busy($("button[type=submit]", form), "Logging in…", async () => {
    try {
      const { data, error } = await auth.signIn.email({ email, password: form.password.value });
      if (error) {
        err.textContent = error.status === 401 ? "Incorrect email or password." : authMessage(error, "Couldn't log in.");
        return;
      }
      currentUser = { email: data.user.email, couple: data.user.name, date: "" };
      form.reset();
      await showApp();
    } catch (ex) {
      err.textContent = ex.message;
    }
  });
}

async function logout() {
  await auth.signOut().catch(() => {});
  currentUser = null;
  households = [];
  render();
  dialog.close();
  switchTab("login");
  showAuth();
}

// ---------- Rendering ----------
const escapeHTML = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const RSVP_LABEL = { attending: "Attending", declined: "Declined", pending: "Awaiting" };
const PRIORITIES = {
  1: "Must have",
  2: "Pretty important",
  3: "Sorta important",
  4: "If there's space",
};
const priorityOf = (h) => Number(h.priority) || 1;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
// Guests who still might come (everyone except those who declined)
const expected = (guests) => guests.filter((g) => g.rsvp !== "declined").length;

function renderStats() {
  const guests = households.flatMap((h) => h.guests);
  const count = (status) => guests.filter((g) => g.rsvp === status).length;
  $("#stat-households").textContent = households.length;
  $("#stat-guests").textContent = guests.length;
  $("#stat-attending").textContent = count("attending");
  $("#stat-declined").textContent = count("declined");
  $("#stat-pending").textContent = count("pending");
}

// Headcount per tier plus a running total, so you can see "if we invite through tier 2, that's N people"
function renderTierBar() {
  const active = $("#filter-priority").value;
  let running = 0;
  $("#tier-bar").innerHTML = Object.entries(PRIORITIES)
    .map(([p, label]) => {
      const inTier = households.filter((h) => priorityOf(h) === Number(p));
      const people = expected(inTier.flatMap((h) => h.guests));
      running += people;
      return `<button type="button" class="tier-cell tier-${p} ${active === p ? "is-active" : ""}" data-priority="${p}"
          aria-pressed="${active === p}" title="Show only ${label}">
        <span class="t-name">${p} · ${label}</span>
        <span class="t-count"><b>${people}</b>expected · ${plural(inTier.length, "household")}</span>
        <span class="t-total">${p === "1" ? "Running total" : `Tiers 1–${p}`}: ${running}</span>
      </button>`;
    })
    .join("");
}

function matchesFilters(h) {
  const q = $("#search").value.trim().toLowerCase();
  const priority = $("#filter-priority").value;
  const side = $("#filter-side").value;
  const rsvp = $("#filter-rsvp").value;
  if (priority && priorityOf(h) !== Number(priority)) return false;
  if (side && h.side !== side) return false;
  if (rsvp && !h.guests.some((g) => g.rsvp === rsvp)) return false;
  if (q) {
    const haystack = [h.name, h.group, h.email, h.address, ...h.guests.map((g) => g.name)].join(" ").toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
}

function householdRow(h) {
  const p = priorityOf(h);
  const chips = h.guests
    .map(
      (g) => `<span class="chip ${g.rsvp}" title="${RSVP_LABEL[g.rsvp]}">${escapeHTML(g.name)}${
        g.type === "child" ? ' <span class="child">child</span>' : ""
      }</span>`
    )
    .join("");
  const options = Object.entries(PRIORITIES)
    .map(([v, label]) => `<option value="${v}" ${Number(v) === p ? "selected" : ""}>${v} · ${label}</option>`)
    .join("");
  return `<div class="household tier-${p}" data-id="${h.id}" role="button" tabindex="0" aria-label="Edit ${escapeHTML(h.name)}">
    <select class="priority-select" aria-label="Priority for ${escapeHTML(h.name)}">${options}</select>
    <div>
      <h4>${escapeHTML(h.name)}</h4>
      <div class="household-meta">
        <span class="tag tag-${h.side}">${escapeHTML(h.side)}</span>
        ${h.group ? `<span>${escapeHTML(h.group)}</span>` : ""}
        <span>${plural(h.guests.length, "guest")}</span>
      </div>
    </div>
    <div class="guest-chips">${chips}</div>
    <div class="status">
      <span class="${h.inviteSent ? "done" : ""}">${h.inviteSent ? "✓" : "○"} Invite</span>
    </div>
  </div>`;
}

function render() {
  renderStats();
  renderTierBar();
  const list = $("#household-list");
  const empty = households.length === 0;
  $("#empty-state").hidden = !empty;
  list.hidden = empty;
  $("#rsvp-legend").hidden = empty;
  if (empty) {
    list.innerHTML = ""; // don't leave a previous account's rows in the DOM
    return;
  }

  const visible = households.filter(matchesFilters);
  list.innerHTML = visible.length
    ? Object.entries(PRIORITIES)
        .map(([p, label]) => {
          const group = visible.filter((h) => priorityOf(h) === Number(p)).sort((a, b) => a.name.localeCompare(b.name));
          if (!group.length) return "";
          const guests = group.flatMap((h) => h.guests);
          const declined = guests.length - expected(guests);
          return `<section class="tier-group tier-${p}">
            <header class="tier-group-head">
              <h3>${p} · ${label}</h3>
              <span>${plural(group.length, "household")} · ${plural(guests.length, "guest")}${declined ? ` (${declined} declined)` : ""}</span>
            </header>
            ${group.map(householdRow).join("")}
          </section>`;
        })
        .join("")
    : '<p class="no-results">No households match your search.</p>';

  $("#group-options").innerHTML = [...new Set(households.map((h) => h.group).filter(Boolean))]
    .map((g) => `<option value="${escapeHTML(g)}">`)
    .join("");
}

// Updates the list right away, then rolls back if the save fails
async function setPriority(id, priority) {
  const h = households.find((x) => x.id === id);
  if (!h) return;
  const previous = h.priority;
  h.priority = Number(priority);
  render();
  try {
    Object.assign(h, await api(`/api/households/${id}`, { method: "PUT", body: h }));
  } catch (ex) {
    h.priority = previous;
    render();
    toast(ex.message);
  }
}

// ---------- Household dialog ----------
const dialog = $("#household-dialog");
const hForm = $("#household-form");

function addGuestRow(guest = {}) {
  const row = $("#guest-row-template").content.firstElementChild.cloneNode(true);
  $(".g-name", row).value = guest.name || "";
  $(".g-type", row).value = guest.type || "adult";
  $(".g-rsvp", row).value = guest.rsvp || "pending";
  $(".g-remove", row).addEventListener("click", () => row.remove());
  $("#guest-rows").append(row);
  return row;
}

function openHousehold(id = null) {
  editingId = id;
  const h = households.find((x) => x.id === id);
  hForm.reset();
  $(".form-error", hForm).textContent = "";
  $("#guest-rows").innerHTML = "";
  $("#dialog-title").textContent = h ? "Edit household" : "Add household";
  $("#delete-household-btn").hidden = !h;

  if (h) {
    for (const field of ["name", "side", "group", "email", "phone", "address", "notes"]) hForm[field].value = h[field] || "";
    hForm.priority.value = String(priorityOf(h));
    hForm.inviteSent.checked = !!h.inviteSent;
    h.guests.forEach(addGuestRow);
  } else {
    addGuestRow();
  }
  dialog.showModal();
  hForm.name.focus();
}

async function saveHousehold(e) {
  e.preventDefault();
  const err = $(".form-error", hForm);
  err.textContent = "";
  const name = hForm.name.value.trim();
  const guests = $$(".guest-row", hForm)
    .map((row) => ({
      name: $(".g-name", row).value.trim(),
      type: $(".g-type", row).value,
      rsvp: $(".g-rsvp", row).value,
    }))
    .filter((g) => g.name);

  if (!name) {
    err.textContent = "Please give this household a name.";
    hForm.name.focus();
    return;
  }
  if (!guests.length) {
    err.textContent = "Add at least one guest with a name.";
    return;
  }

  const record = {
    name,
    priority: Number(hForm.priority.value) || 1,
    side: hForm.side.value,
    group: hForm.group.value.trim(),
    email: hForm.email.value.trim(),
    phone: hForm.phone.value.trim(),
    address: hForm.address.value.trim(),
    notes: hForm.notes.value.trim(),
    inviteSent: hForm.inviteSent.checked,
    guests,
  };

  await busy($("button[type=submit]", hForm), "Saving…", async () => {
    try {
      const saved = editingId
        ? await api(`/api/households/${editingId}`, { method: "PUT", body: record })
        : await api("/api/households", { method: "POST", body: record });
      const idx = households.findIndex((h) => h.id === saved.id);
      if (idx >= 0) households[idx] = saved;
      else households.push(saved);
      dialog.close();
      render();
    } catch (ex) {
      err.textContent = ex.message;
    }
  });
}

async function deleteHousehold() {
  const h = households.find((x) => x.id === editingId);
  if (!h || !confirm(`Delete "${h.name}" and all its guests?`)) return;
  await busy($("#delete-household-btn"), "Deleting…", async () => {
    try {
      await api(`/api/households/${h.id}`, { method: "DELETE" });
      households = households.filter((x) => x.id !== h.id);
      dialog.close();
      render();
    } catch (ex) {
      $(".form-error", hForm).textContent = ex.message;
    }
  });
}

// ---------- CSV export ----------
function exportCSV() {
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = [["Priority", "Household", "Side", "Group", "Guest", "Age", "RSVP", "Email", "Phone", "Address", "Invitation", "Notes"]];
  const sorted = [...households].sort((a, b) => priorityOf(a) - priorityOf(b) || a.name.localeCompare(b.name));
  for (const h of sorted) {
    for (const g of h.guests) {
      rows.push([`${priorityOf(h)} - ${PRIORITIES[priorityOf(h)]}`, h.name, h.side, h.group, g.name, g.type, RSVP_LABEL[g.rsvp], h.email, h.phone, h.address,
        h.inviteSent ? "Yes" : "No", h.notes]);
    }
  }
  const blob = new Blob([rows.map((r) => r.map(cell).join(",")).join("\r\n")], { type: "text/csv" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "guest-list.csv" });
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- Wire up ----------
$$(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));
$("#signup-form").addEventListener("submit", handleSignup);
$("#login-form").addEventListener("submit", handleLogin);
$("#logout-btn").addEventListener("click", logout);
$("#export-btn").addEventListener("click", exportCSV);

$("#add-household-btn").addEventListener("click", () => openHousehold());
$('#empty-state [data-action="add"]').addEventListener("click", () => openHousehold());
const list = $("#household-list");
list.addEventListener("click", (e) => {
  if (e.target.closest(".priority-select")) return; // changing priority inline shouldn't open the editor
  const row = e.target.closest(".household");
  if (row) openHousehold(row.dataset.id);
});
list.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("household")) {
    e.preventDefault();
    openHousehold(e.target.dataset.id);
  }
});
list.addEventListener("change", (e) => {
  if (e.target.matches(".priority-select")) setPriority(e.target.closest(".household").dataset.id, e.target.value);
});
$("#tier-bar").addEventListener("click", (e) => {
  const cell = e.target.closest(".tier-cell");
  if (!cell) return;
  const filter = $("#filter-priority");
  filter.value = filter.value === cell.dataset.priority ? "" : cell.dataset.priority; // click again to clear
  render();
});
["#search", "#filter-priority", "#filter-side", "#filter-rsvp"].forEach((s) => $(s).addEventListener("input", render));

$("#add-guest-btn").addEventListener("click", () => $(".g-name", addGuestRow()).focus());
hForm.addEventListener("submit", saveHousehold);
$("#delete-household-btn").addEventListener("click", deleteHousehold);
$$("[data-close]", dialog).forEach((b) => b.addEventListener("click", () => dialog.close()));

// Restore an existing session, otherwise show the login screen
try {
  const { data } = await auth.getSession();
  if (data?.user) {
    currentUser = { email: data.user.email, couple: data.user.name, date: "" };
    await showApp();
  } else {
    showAuth();
  }
} catch (ex) {
  showAuth();
  toast(ex.message);
}
