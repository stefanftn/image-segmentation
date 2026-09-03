// sidebar.js — the mobile hamburger drawer.
//
// Standalone like theme.js/ui/edittabs.js: it never reads or writes
// body[data-state]/[data-ready]/body.authed. Its own state is just "is the
// drawer open", tracked with one class on #appSidebar.
//
// "New photo" and "Sign out" inside the drawer are NOT a second copy of that
// logic — they forward a real click to the existing #newImageBtn/#logoutBtn,
// which already carry the actual handlers wired in app.js. That keeps this
// file from needing to know anything about sessions, uploads, or auth; it
// only has to find two buttons and click them. Their visibility already
// follows body.has-image / body.authed the same way the originals do — see
// the sidebar rules in styles.css — so a "New photo" item never appears
// before there's a photo to reset.

const sidebar = document.getElementById("appSidebar");
const backdrop = document.getElementById("sidebarBackdrop");
const openBtn = document.getElementById("sidebarToggle");
const closeBtn = document.getElementById("sidebarClose");
const newPhotoBtn = document.getElementById("sidebarNewPhoto");
const signOutBtn = document.getElementById("sidebarSignOut");

if (sidebar && backdrop && openBtn) {
  function setOpen(open) {
    sidebar.classList.toggle("is-open", open);
    sidebar.setAttribute("aria-hidden", String(!open));
    backdrop.hidden = !open;
    openBtn.setAttribute("aria-expanded", String(open));
    // Prevents the page behind the drawer from scrolling on touch devices
    // while it's open — the drawer itself still scrolls if its own content
    // is taller than the screen.
    document.body.classList.toggle("sidebar-open", open);
  }

  openBtn.addEventListener("click", () => setOpen(true));
  closeBtn?.addEventListener("click", () => setOpen(false));
  backdrop.addEventListener("click", () => setOpen(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && sidebar.classList.contains("is-open")) setOpen(false);
  });

  newPhotoBtn?.addEventListener("click", () => {
    document.getElementById("newImageBtn")?.click();
    setOpen(false);
  });
  signOutBtn?.addEventListener("click", () => {
    document.getElementById("logoutBtn")?.click();
    setOpen(false);
  });
}
