(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const NTS = window.NTS = window.NTS || {};
  const client = () => NTS.supabase;
  const toast = (title, message, kind = "info", duration) => NTS.showToast?.(title, message, kind, duration);
  const fallbackAvatar = () => window.APP_CONFIG?.BRAND?.defaultAvatarUrl || "assets/brand/avatar-default.png";
  const IS_MOBILE = matchMedia("(max-width: 760px)").matches || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "");

  const state = {
    user: null,
    account: null,
    pageOpen: false,
    activeTab: "people",
    directory: [],
    messengerContacts: [],
    activePeer: null,
    friendshipChannel: null,
    messageChannel: null,
    presenceChannel: null,
    publicProfileChannel: null,
    presenceKey: null,
    onlineUserIds: new Set(),
    searchTimer: null,
    refreshTimer: null,
    contactRefreshTimer: null,
    sending: false,
    loadingMessages: false,
    unread: 0,
    messengerPanelOpen: false,
    floatingWindows: new Map(),
    windowOrder: [],
    incomingPreviewTimer: null,
    avatarRefreshTimer: null,
    directoryRequestId: 0,
    contactsRequestId: 0,
    rpcPreferred: new Map()
  };

  function roleLabel(member) { return NTS.avatar?.roleLabel?.(member) || (member?.role === "admin" ? "ADMIN" : member?.is_vip ? "VIP" : "FREE"); }
  function roleClass(member) { return NTS.avatar?.roleClass?.(member) || (member?.role === "admin" ? "admin" : member?.is_vip ? "vip" : "free"); }
  function formatTime(value) {
    if (!value) return "";
    try {
      const d = new Date(value);
      const today = new Date();
      const sameDay = d.toDateString() === today.toDateString();
      return new Intl.DateTimeFormat("vi-VN", sameDay ? { hour: "2-digit", minute: "2-digit" } : { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(d);
    } catch (_) { return ""; }
  }
  function statusText(status) {
    const map = { new: "Mới", reviewing: "Đang xem", planned: "Đã lên kế hoạch", resolved: "Đã xử lý", rejected: "Từ chối", archived: "Lưu trữ" };
    return map[status] || status || "—";
  }
  function peerId(member) { return member?.user_id || member?.peer_id || null; }
  function isOnline(id) { return Boolean(id && state.onlineUserIds.has(String(id))); }
  function normalizeContact(row) {
    if (!row) return null;
    return {
      ...row,
      user_id: row.user_id || row.peer_id,
      friendship_status: row.friendship_status || "accepted",
      friendship_direction: row.friendship_direction || "accepted"
    };
  }
  function findMember(id) {
    const sid = String(id || "");
    return state.directory.find(x => String(x.user_id) === sid)
      || normalizeContact(state.messengerContacts.find(x => String(x.peer_id) === sid));
  }
  function truncate(text, max = 72) {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
  }


  function storageAvatarUrl(member) {
    const id = peerId(member);
    if (!id || !client()?.storage) return null;
    try {
      const { data } = client().storage.from("profile-media").getPublicUrl(`${id}/avatar.jpg`);
      return data?.publicUrl || null;
    } catch (_) { return null; }
  }

  function addAvatarVersion(url, version) {
    if (!url || String(url).startsWith("blob:") || String(url).startsWith("data:")) return url;
    try {
      const u = new URL(url, window.location.href);
      const stamp = version ? new Date(version).getTime() : Date.now();
      u.searchParams.set("v", String(Number.isFinite(stamp) ? stamp : version || Date.now()));
      return u.href;
    } catch (_) {
      const joiner = String(url).includes("?") ? "&" : "?";
      return `${url}${joiner}v=${encodeURIComponent(version || Date.now())}`;
    }
  }

  function avatarCandidates(member) {
    const values = [];
    const raw = String(member?.avatar_url || "").trim();
    if (raw) values.push(addAvatarVersion(raw, member?.avatar_version));
    const canonical = storageAvatarUrl(member);
    if (canonical && !values.includes(canonical)) values.push(addAvatarVersion(canonical, member?.avatar_version));
    values.push(fallbackAvatar());
    return [...new Set(values.filter(Boolean))];
  }

  function avatarUrl(member) {
    return avatarCandidates(member)[0] || fallbackAvatar();
  }

  async function rpcWithFallback(primary, fallback, args) {
    return rpcCascade([primary, fallback].filter(Boolean), args);
  }

  async function rpcCascade(names, args) {
    const available = names.filter(Boolean);
    if (!available.length) return { data:null, error:new Error("RPC_NOT_AVAILABLE") };
    const cacheKey = available.join("|");
    const preferred = state.rpcPreferred.get(cacheKey);
    const ordered = preferred && available.includes(preferred)
      ? [preferred, ...available.filter(name => name !== preferred)]
      : available;
    let last = { data:null, error:new Error("RPC_NOT_AVAILABLE") };
    for (const name of ordered) {
      const operation = () => client().rpc(name, args);
      try {
        const result = NTS.health?.resilient
          ? await NTS.health.resilient(operation, { attempts: 2, timeout: 8000, label: name })
          : await operation();
        last = result;
        if (!result?.error) {
          state.rpcPreferred.set(cacheKey, name);
          return result;
        }
        const message = String(result.error?.message || "");
        if (!/function|schema cache|does not exist|PGRST202/i.test(message)) return result;
        if (preferred === name) state.rpcPreferred.delete(cacheKey);
      } catch (error) {
        last = { data:null, error };
        if (!NTS.health?.isSchemaError?.(error)) return last;
        if (preferred === name) state.rpcPreferred.delete(cacheKey);
      }
    }
    return last;
  }

  async function safeRpc(name, args, { silent = true } = {}) {
    try {
      const result = await client().rpc(name, args);
      if (result?.error) throw result.error;
      return result?.data ?? null;
    } catch (error) {
      if (!silent) console.warn(`RPC ${name} failed`, error);
      return null;
    }
  }

  function setTab(tab) {
    state.activeTab = ["people", "chat", "feedback"].includes(tab) ? tab : "people";
    document.querySelectorAll(".v37-community-tab").forEach(btn => btn.classList.toggle("active", btn.dataset.communityTab === state.activeTab));
    [["people", "communityPeoplePanel"], ["chat", "communityChatPanel"], ["feedback", "communityFeedbackPanel"]].forEach(([name, id]) => $(id)?.classList.toggle("hidden", name !== state.activeTab));
    if (state.activeTab === "chat") { renderContacts(); if (state.activePeer) openChat(state.activePeer, { focus: false }); }
    if (state.activeTab === "feedback") loadMyFeedback();
  }

  function memberAvatar(member, compact = false) {
    const id = peerId(member);
    const wrap = document.createElement("div");
    wrap.className = `${compact ? "v37-member-avatar compact" : "v37-member-avatar"} v39-avatar-role-${roleClass(member)}${isOnline(id) ? " is-online" : ""}`;
    wrap.dataset.userId = id || "";
    const frame = document.createElement("span");
    frame.className = "v310-avatar-frame";
    const img = document.createElement("img");
    img.alt = member?.display_name ? `Ảnh đại diện ${member.display_name}` : "Ảnh đại diện";
    if (NTS.avatar?.bindImage) NTS.avatar.bindImage(img, member, { lazy:false, hydrate:!member?.avatar_thumb_data });
    else {
      const direct = member?.avatar_url || storageAvatarUrl(member) || fallbackAvatar();
      img.src = addAvatarVersion(direct, member?.avatar_storage_version || member?.avatar_version || Date.now());
      img.onerror = () => { img.onerror = null; img.src = fallbackAvatar(); };
    }
    if (Number(member?.avatar_crop_version || 0) >= 1) img.dataset.v311Final = "1";
    frame.append(img);
    const badge = document.createElement("span");
    badge.className = `v37-role-dot ${roleClass(member)}`;
    badge.textContent = roleLabel(member);
    badge.title = roleLabel(member);
    const online = document.createElement("i");
    online.className = "v38-online-dot";
    online.title = "Online";
    wrap.append(frame, badge);
    if (isOnline(id)) wrap.append(online);
    return wrap;
  }

  function updatePresenceUi() {
    const onlineCount = state.directory.filter(m => isOnline(m.user_id)).length;
    if ($("communityOnlineCount")) $("communityOnlineCount").textContent = `${onlineCount} online`;
    if ($("messengerOnlineCount")) $("messengerOnlineCount").textContent = `${state.messengerContacts.filter(m => isOnline(m.peer_id)).length} online`;
    renderDirectory();
    renderContacts();
    renderMessengerPanel();
    for (const [id] of state.floatingWindows) updateFloatingWindowHeader(id);
  }

  async function loadDirectory(search = "") {
    if (!state.user || !client()) return;
    const requestId = ++state.directoryRequestId;
    try {
      const { data, error } = await rpcCascade(["list_member_directory_v316","list_member_directory_v3131","list_member_directory_v313","list_member_directory_v312","list_member_directory_v311","list_member_directory_v310"], { p_search: search.trim(), p_limit: 60 });
      if (error) throw error;
      if (requestId !== state.directoryRequestId) return;
      state.directory = Array.isArray(data) ? data : [];
      renderDirectory();
      renderRequests();
      renderContacts();
      // V3.14: resolve the exact Storage avatar for every visible member in one batch.
      // UI renders immediately; resolved images replace fallbacks asynchronously.
      const missingAvatars = state.directory.filter(m => !m?.avatar_thumb_data);
      if (missingAvatars.length) NTS.avatar?.hydrateMembers?.(missingAvatars).catch?.(() => {});
    } catch (error) {
      if (requestId !== state.directoryRequestId) return;
      console.error("community directory", error);
      if ($("communityMemberList")) $("communityMemberList").innerHTML = `<div class="v37-empty-state">Không tải được danh bạ: ${escapeHtml(error?.message || "Kiểm tra migration 005.")}</div>`;
    }
  }

  async function loadMessengerContacts({ silent = false } = {}) {
    if (!state.user || !client()) return;
    const requestId = ++state.contactsRequestId;
    try {
      const { data, error } = await rpcCascade(["list_messenger_contacts_v316","list_messenger_contacts_v3131","list_messenger_contacts_v313","list_messenger_contacts_v312","list_messenger_contacts_v311","list_messenger_contacts_v310"], { p_limit: 60 });
      if (error) throw error;
      if (requestId !== state.contactsRequestId) return;
      state.messengerContacts = Array.isArray(data) ? data : [];
      state.unread = state.messengerContacts.reduce((sum, x) => sum + Number(x.unread_count || 0), 0);
      renderUnread();
      renderMessengerPanel();
      renderContacts();
      // Same Avatar Hub powers chat list, quick Messenger and floating chat windows.
      const missingMessengerAvatars = state.messengerContacts.filter(m => !m?.avatar_thumb_data);
      if (missingMessengerAvatars.length) NTS.avatar?.hydrateMembers?.(missingMessengerAvatars).catch?.(() => {});
    } catch (error) {
      if (requestId !== state.contactsRequestId) return;
      if (!silent) console.error("messenger contacts", error);
      // Migration 006 may not be installed yet. Fall back to existing directory/unread behavior.
      await loadUnreadCount();
    }
  }

  function renderDirectory() {
    const root = $("communityMemberList");
    if (!root) return;
    root.replaceChildren();
    if ($("communityMemberCount")) $("communityMemberCount").textContent = String(state.directory.length);
    const people = state.directory.filter(x => x.friendship_direction !== "incoming" || x.friendship_status !== "pending");
    if (!people.length) {
      const empty = document.createElement("div"); empty.className = "v37-empty-state"; empty.textContent = "Không tìm thấy hội viên phù hợp."; root.append(empty); return;
    }
    const frag = document.createDocumentFragment();
    for (const member of people) {
      const card = document.createElement("article");
      card.className = `v37-member-card${isOnline(member.user_id) ? " is-online" : ""}`;
      card.dataset.userId = member.user_id;
      const identity = document.createElement("div"); identity.className = "v37-member-identity";
      identity.append(memberAvatar(member));
      const copy = document.createElement("div");
      const name = document.createElement("strong"); name.textContent = member.display_name || "Hội viên";
      const meta = document.createElement("span");
      const base = member.role === "admin" ? "Quản trị viên NTS" : member.is_vip ? "Hội viên VIP" : "Hội viên Free";
      meta.textContent = base;
      copy.append(name, meta); identity.append(copy); card.append(identity);
      const actions = document.createElement("div"); actions.className = "v37-member-actions";
      if (member.friendship_status === "accepted") {
        const chat = document.createElement("button"); chat.className = "primary-button compact"; chat.type = "button"; chat.textContent = "Nhắn tin";
        chat.addEventListener("click", () => openFloatingChat(member));
        const view = document.createElement("button"); view.className = "secondary-button compact"; view.type = "button"; view.textContent = "Mở Messenger";
        view.addEventListener("click", () => { setTab("chat"); openChat(member); });
        const remove = document.createElement("button"); remove.className = "text-button"; remove.type = "button"; remove.textContent = "Hủy kết bạn";
        remove.addEventListener("click", () => removeFriend(member));
        actions.append(chat, view, remove);
      } else if (member.friendship_status === "pending" && member.friendship_direction === "outgoing") {
        const wait = document.createElement("button"); wait.className = "secondary-button compact"; wait.type = "button"; wait.disabled = true; wait.textContent = "Đã gửi lời mời"; actions.append(wait);
      } else {
        const add = document.createElement("button"); add.className = "primary-button compact"; add.type = "button"; add.textContent = member.friendship_status === "declined" ? "Kết bạn lại" : "Kết bạn";
        add.addEventListener("click", () => sendFriend(member, add)); actions.append(add);
      }
      card.append(actions); frag.append(card);
    }
    root.append(frag);
  }

  function renderRequests() {
    const root = $("friendRequestsList"); if (!root) return; root.replaceChildren();
    const rows = state.directory.filter(x => x.friendship_status === "pending" && x.friendship_direction === "incoming");
    if (!rows.length) { const e = document.createElement("div"); e.className = "v37-empty-state small"; e.textContent = "Chưa có lời mời."; root.append(e); return; }
    for (const member of rows) {
      const row = document.createElement("div"); row.className = "v37-request-row"; row.append(memberAvatar(member, true));
      const copy = document.createElement("div"); const strong = document.createElement("strong"); strong.textContent = member.display_name; const span = document.createElement("span"); span.textContent = `${roleLabel(member)} · muốn kết bạn`; copy.append(strong, span); row.append(copy);
      const acts = document.createElement("div");
      const yes = document.createElement("button"); yes.className = "primary-button mini"; yes.textContent = "✓"; yes.title = "Chấp nhận"; yes.type = "button"; yes.addEventListener("click", () => respondFriend(member, "accept"));
      const no = document.createElement("button"); no.className = "secondary-button mini"; no.textContent = "×"; no.title = "Từ chối"; no.type = "button"; no.addEventListener("click", () => respondFriend(member, "decline"));
      acts.append(yes, no); row.append(acts); root.append(row);
    }
  }

  async function sendFriend(member, button) {
    if (!client()) return;
    button.disabled = true;
    try {
      const { error } = await client().rpc("send_friend_request", { p_target: member.user_id }); if (error) throw error;
      toast("Đã gửi lời mời", `Đã gửi lời mời kết bạn tới ${member.display_name}.`, "success");
      await loadDirectory($("communityMemberSearch")?.value || "");
    } catch (error) { console.error(error); toast("Không gửi được lời mời", error.message || String(error), "error"); }
    finally { button.disabled = false; }
  }
  async function respondFriend(member, action) {
    try {
      const { error } = await client().rpc("respond_friend_request", { p_friendship: member.friendship_id, p_action: action }); if (error) throw error;
      toast(action === "accept" ? "Đã kết bạn" : "Đã từ chối", action === "accept" ? `Bạn và ${member.display_name} có thể nhắn tin.` : "Lời mời đã được từ chối.", action === "accept" ? "success" : "info");
      await Promise.all([loadDirectory($("communityMemberSearch")?.value || ""), loadMessengerContacts({ silent: true })]);
    } catch (error) { console.error(error); toast("Không cập nhật được lời mời", error.message || String(error), "error"); }
  }
  async function removeFriend(member) {
    const ok = await NTS.dialog?.confirm?.({ title: "Hủy kết bạn?", message: `Bạn sẽ không thể nhắn tin với ${member.display_name} cho đến khi kết bạn lại.`, confirmText: "Hủy kết bạn", danger: true });
    if (!ok) return;
    try {
      const { error } = await client().rpc("remove_friendship", { p_friendship: member.friendship_id }); if (error) throw error;
      if (state.activePeer?.user_id === member.user_id) closeChat();
      closeFloatingWindow(member.user_id);
      await Promise.all([loadDirectory($("communityMemberSearch")?.value || ""), loadMessengerContacts({ silent: true })]);
    } catch (error) { toast("Không hủy được kết bạn", error.message || String(error), "error"); }
  }

  function renderContacts() {
    const root = $("chatContactList"); if (!root) return; root.replaceChildren();
    const rich = state.messengerContacts.length
      ? state.messengerContacts.map(normalizeContact)
      : state.directory.filter(x => x.friendship_status === "accepted");
    if (!rich.length) { const e = document.createElement("div"); e.className = "v37-empty-state small"; e.textContent = "Chưa có bạn bè. Hãy gửi lời mời ở tab Hội viên."; root.append(e); return; }
    for (const member of rich) {
      const id = peerId(member);
      const btn = document.createElement("button");
      btn.type = "button"; btn.className = `v37-chat-contact${state.activePeer?.user_id === id ? " active" : ""}${isOnline(id) ? " is-online" : ""}`;
      btn.append(memberAvatar(member, true));
      const copy = document.createElement("span");
      const strong = document.createElement("strong"); strong.textContent = member.display_name || "Hội viên";
      const small = document.createElement("small");
      small.textContent = member.last_message ? truncate(member.last_message, 38) : roleLabel(member);
      copy.append(strong, small); btn.append(copy);
      if (Number(member.unread_count || 0) > 0) { const badge = document.createElement("b"); badge.className = "v38-contact-unread"; badge.textContent = String(member.unread_count); btn.append(badge); }
      btn.addEventListener("click", () => openChat(member)); root.append(btn);
    }
  }

  function closeMessageChannel() {
    if (state.messageChannel && client()) { try { void client().removeChannel(state.messageChannel); } catch (_) {} }
    state.messageChannel = null;
  }
  function closeFriendshipChannel() {
    if (state.friendshipChannel && client()) { try { void client().removeChannel(state.friendshipChannel); } catch (_) {} }
    state.friendshipChannel = null;
  }
  function closePresenceChannel() {
    if (state.presenceChannel && client()) {
      try { state.presenceChannel.untrack?.(); } catch (_) {}
      try { void client().removeChannel(state.presenceChannel); } catch (_) {}
    }
    state.presenceChannel = null;
    state.onlineUserIds.clear();
  }
  function closePublicProfileChannel() {
    if (state.publicProfileChannel && client()) {
      try { void client().removeChannel(state.publicProfileChannel); } catch (_) {}
    }
    state.publicProfileChannel = null;
  }

  function closeChat() {
    state.activePeer = null;
    if ($("chatMessageInput")) $("chatMessageInput").disabled = true;
    if ($("sendChatMessage")) $("sendChatMessage").disabled = true;
    $("chatMessages")?.replaceChildren(Object.assign(document.createElement("div"), { className: "v37-chat-empty", textContent: "Chọn một hội viên để trò chuyện." }));
    if ($("chatRoomHeader")) $("chatRoomHeader").innerHTML = '<div class="v37-chat-placeholder-title"><strong>Chọn một người bạn</strong><span>Tin nhắn chỉ hiển thị giữa hai tài khoản.</span></div>';
    renderContacts();
  }

  async function getMemberPublic(id) {
    const found = findMember(id); if (found) return found;
    try {
      const { data, error } = await rpcCascade(["get_member_public_profile_v316","get_member_public_profile_v3131","get_member_public_profile_v313","get_member_public_profile_v312","get_member_public_profile_v311","get_member_public_profile_v310"], { p_user: id });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return row ? normalizeContact({ ...row, peer_id: row.user_id }) : null;
    } catch (error) { console.warn("peer profile", error); return null; }
  }

  async function openChat(member, { focus = true } = {}) {
    member = normalizeContact(member);
    if (!member || member.friendship_status !== "accepted") return;
    state.activePeer = member; renderContacts();
    const head = $("chatRoomHeader");
    if (head) {
      head.replaceChildren();
      const left = document.createElement("div"); left.className = "v37-chat-peer"; left.append(memberAvatar(member, true));
      const copy = document.createElement("div"); const strong = document.createElement("strong"); strong.textContent = member.display_name;
      const small = document.createElement("span"); small.textContent = member.role === "admin" ? "Quản trị viên · Tin nhắn riêng tư" : `${roleLabel(member)} · Tin nhắn riêng tư`;
      copy.append(strong, small); left.append(copy); head.append(left);
      const floating = document.createElement("button"); floating.type = "button"; floating.className = "secondary-button compact"; floating.textContent = "Mở cửa sổ chat"; floating.addEventListener("click", () => openFloatingChat(member)); head.append(floating);
    }
    if ($("chatMessageInput")) $("chatMessageInput").disabled = false;
    if ($("sendChatMessage")) $("sendChatMessage").disabled = false;
    await loadMessages(); if (focus) setTimeout(() => $("chatMessageInput")?.focus(), 30);
  }

  async function fetchConversation(peer, limit = 80) {
    const args = { p_peer: peer, p_limit: limit, p_before: null };
    const names = ["list_direct_messages_v311", "list_direct_messages_v3101", "list_direct_messages"];
    let lastError = null;
    for (const name of names) {
      try {
        const result = await client().rpc(name, args);
        if (!result?.error) return Array.isArray(result?.data) ? result.data : [];
        lastError = result.error;
        const msg = String(result.error?.message || "");
        if (!/function|schema cache|does not exist|PGRST202/i.test(msg)) throw result.error;
      } catch (error) {
        lastError = error;
        const msg = String(error?.message || "");
        if (!/function|schema cache|does not exist|PGRST202/i.test(msg)) throw error;
      }
    }
    throw lastError || new Error("Không tìm thấy RPC đọc hội thoại. Hãy chạy migration 010 V3.11.");
  }

  async function loadMessages() {
    if (!state.user || !state.activePeer || state.loadingMessages) return;
    state.loadingMessages = true;
    const root = $("chatMessages"); if (root) root.innerHTML = '<div class="v37-chat-empty">Đang tải tin nhắn...</div>';
    try {
      const rows = await fetchConversation(state.activePeer.user_id, 80);
      renderMessages(rows);
      await markPeerRead(state.activePeer.user_id);
    } catch (error) {
      console.error("loadMessages", error);
      if (root) root.innerHTML = `<div class="v37-chat-empty"><strong>Không tải được tin nhắn.</strong><br><small>${escapeHtml(error?.message || "Hãy chạy migration 010 V3.11 và tải lại trang.")}</small></div>`;
    } finally { state.loadingMessages = false; }
  }

  function renderMessages(rows) {
    const root = $("chatMessages"); if (!root) return; root.replaceChildren();
    if (!rows.length) { const e = document.createElement("div"); e.className = "v37-chat-empty"; e.textContent = "Chưa có tin nhắn. Hãy gửi lời chào đầu tiên."; root.append(e); return; }
    const frag = document.createDocumentFragment(); for (const row of rows) frag.append(messageNode(row)); root.append(frag); root.scrollTop = root.scrollHeight;
  }
  function messageMetaText(row, mine) {
    const bits = [formatTime(row.created_at)];
    if (row.edited_at && !row.revoked_at) bits.push("Đã chỉnh sửa");
    if (mine && row.read_at) bits.push("Đã xem");
    return bits.join(" · ");
  }

  async function editOwnMessage(row) {
    if (!row?.id || row.sender_id !== state.user?.id || row.revoked_at) return;
    const nodes = [...document.querySelectorAll(`[data-message-id="${CSS.escape(String(row.id))}"]`)];
    if (!nodes.length) return;
    const primary = nodes[0];
    if (primary.querySelector(".v39-message-edit-box")) return;
    const body = primary.querySelector("p");
    const actions = primary.querySelector(".v39-message-actions");
    if (!body) return;
    actions?.removeAttribute("open");
    body.classList.add("hidden");
    const box = document.createElement("div"); box.className = "v39-message-edit-box";
    const input = document.createElement("textarea"); input.maxLength = 2000; input.rows = 2; input.value = row.body || "";
    const buttons = document.createElement("div"); buttons.className = "v39-message-edit-buttons";
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "Hủy";
    const save = document.createElement("button"); save.type = "button"; save.className = "save"; save.textContent = "Lưu";
    buttons.append(cancel, save); box.append(input, buttons); body.after(box);
    const finish = () => { box.remove(); body.classList.remove("hidden"); };
    cancel.addEventListener("click", finish);
    save.addEventListener("click", async () => {
      const value = input.value.trim();
      if (!value || value === String(row.body || "")) return finish();
      save.disabled = true;
      try {
        const { data, error } = await client().rpc("edit_direct_message", { p_message: Number(row.id), p_body: value });
        if (error) throw error;
        const updated = Array.isArray(data) ? data[0] : data;
        if (updated) applyMessageUpdate(updated);
        scheduleContactsRefresh(80);
      } catch (error) {
        console.error("edit message", error);
        toast("Không sửa được tin nhắn", error.message || String(error), "error");
        save.disabled = false;
      }
    });
    input.addEventListener("keydown", e => {
      if (e.key === "Escape") finish();
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save.click(); }
    });
    setTimeout(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }, 20);
  }

  async function revokeOwnMessage(row) {
    if (!row?.id || row.sender_id !== state.user?.id || row.revoked_at) return;
    const ok = await NTS.dialog?.confirm?.({
      title: "Thu hồi tin nhắn?",
      message: "Nội dung sẽ được thay bằng trạng thái ‘Tin nhắn đã được thu hồi’ ở cả hai phía.",
      confirmText: "Thu hồi",
      danger: true
    });
    if (!ok) return;
    try {
      const { data, error } = await client().rpc("revoke_direct_message", { p_message: Number(row.id) });
      if (error) throw error;
      const updated = Array.isArray(data) ? data[0] : data;
      if (updated) applyMessageUpdate(updated);
      scheduleContactsRefresh(80);
      toast("Đã thu hồi", "Tin nhắn đã được thu hồi ở cả hai phía.", "success", 2600);
    } catch (error) {
      console.error("revoke message", error);
      toast("Không thu hồi được", error.message || String(error), "error");
    }
  }

  function messageNode(row, floating = false) {
    const mine = row.sender_id === state.user?.id;
    const revoked = Boolean(row.revoked_at);
    const wrap = document.createElement("article");
    wrap.className = `${floating ? "v38-float-message" : "v37-message"} ${mine ? "mine" : "theirs"}${revoked ? " revoked" : ""}`;
    wrap.dataset.messageId = String(row.id);

    const body = document.createElement("p");
    body.textContent = revoked ? "Tin nhắn đã được thu hồi" : row.body;
    if (revoked) body.classList.add("v39-revoked-body");
    const meta = document.createElement("span"); meta.className = "v39-message-meta"; meta.textContent = messageMetaText(row, mine);
    wrap.append(body, meta);

    if (mine && !revoked) {
      const details = document.createElement("details"); details.className = "v39-message-actions";
      const summary = document.createElement("summary"); summary.setAttribute("aria-label", "Tùy chọn tin nhắn"); summary.title = "Tùy chọn"; summary.textContent = "•••";
      const menu = document.createElement("div"); menu.className = "v39-message-menu";
      const edit = document.createElement("button"); edit.type = "button"; edit.textContent = "Chỉnh sửa";
      const revoke = document.createElement("button"); revoke.type = "button"; revoke.className = "danger"; revoke.textContent = "Thu hồi";
      edit.addEventListener("click", e => { e.preventDefault(); details.removeAttribute("open"); editOwnMessage(row); });
      revoke.addEventListener("click", e => { e.preventDefault(); details.removeAttribute("open"); revokeOwnMessage(row); });
      menu.append(edit, revoke); details.append(summary, menu); wrap.append(details);
    }
    return wrap;
  }

  function applyMessageUpdate(row) {
    if (!row?.id) return;
    const selector = `[data-message-id="${CSS.escape(String(row.id))}"]`;
    document.querySelectorAll(selector).forEach(node => {
      const floating = node.classList.contains("v38-float-message");
      node.replaceWith(messageNode(row, floating));
    });
  }
  function appendMessageToRoot(root, row, floating = false) {
    if (!root || !row) return;
    const selector = `[data-message-id="${CSS.escape(String(row.id))}"]`;
    if (root.querySelector(selector)) return;
    root.querySelector(".v37-chat-empty,.v38-float-empty")?.remove();
    root.append(messageNode(row, floating)); root.scrollTop = root.scrollHeight;
  }
  function appendMessage(row) { appendMessageToRoot($("chatMessages"), row, false); }

  async function markPeerRead(id) {
    if (!id || !client()) return;
    await safeRpc("mark_messages_read", { p_peer: id });
    await loadMessengerContacts({ silent: true });
  }

  function renderUnread() {
    for (const id of ["communityUnreadBadge", "messengerUnreadBadge"]) {
      const badge = $(id); if (!badge) continue; badge.textContent = String(state.unread || 0); badge.classList.toggle("hidden", !state.unread);
    }
    const launcher = $("messengerLauncher"); if (launcher) launcher.classList.toggle("has-unread", state.unread > 0);
  }
  async function loadUnreadCount() {
    if (!state.user || !client()) return;
    try {
      const { count, error } = await client().from("direct_messages").select("id", { count: "exact", head: true }).eq("recipient_id", state.user.id).is("read_at", null).is("deleted_at", null);
      if (error) throw error; state.unread = Number(count || 0); renderUnread();
    } catch (error) { console.warn("unread count", error); }
  }

  function isConversationVisible(id) {
    if (state.pageOpen && state.activeTab === "chat" && String(state.activePeer?.user_id) === String(id)) return true;
    const entry = state.floatingWindows.get(String(id));
    return Boolean(entry && !entry.minimized && !entry.closed);
  }

  function handleMessageUpdate(row) {
    if (!row?.id) return;
    applyMessageUpdate(row);
    scheduleContactsRefresh(90);
  }

  function scheduleContactsRefresh(delay = 220) {
    clearTimeout(state.contactRefreshTimer);
    state.contactRefreshTimer = setTimeout(() => loadMessengerContacts({ silent: true }), delay);
  }

  async function handleIncomingMessage(row) {
    if (!row?.sender_id) return;
    let member = await getMemberPublic(row.sender_id);
    if (!member) member = { user_id: row.sender_id, display_name: "Hội viên", avatar_url: null, role: "member", plan: "free", is_vip: false, friendship_status: "accepted" };

    if (state.pageOpen && state.activeTab === "chat" && String(state.activePeer?.user_id) === String(row.sender_id)) appendMessage(row);
    const float = state.floatingWindows.get(String(row.sender_id));
    if (float) appendMessageToRoot(float.messages, row, true);

    if (isConversationVisible(row.sender_id)) {
      await safeRpc("mark_messages_read", { p_peer: row.sender_id });
      scheduleContactsRefresh(80);
    } else {
      state.unread += 1; renderUnread();
      showIncomingPreview(member, row);
      if (!IS_MOBILE && document.visibilityState === "visible") openFloatingChat(member, { minimized: false, fromIncoming: true, load: true });
      scheduleContactsRefresh(120);
    }
  }

  function normalizePublicProfileRow(row) {
    if (!row?.user_id) return null;
    return {
      user_id: row.user_id,
      peer_id: row.user_id,
      display_name: row.display_name || "Hội viên",
      avatar_url: row.avatar_url || null,
      avatar_thumb_data: row.avatar_thumb_data || null,
      oauth_avatar_url: row.oauth_avatar_url || null,
      avatar_storage_path: row.avatar_object_path || row.avatar_storage_path || null,
      avatar_storage_version: row.avatar_updated_at || row.updated_at || null,
      avatar_revision: Number(row.avatar_revision || 0),
      avatar_crop_version: Number(row.avatar_crop_version || 0),
      role: row.role || "member",
      plan: row.plan || "free",
      is_vip: row.role === "admin" || (row.plan === "vip" && row.status === "active" && (!row.vip_until || new Date(row.vip_until) > new Date()))
    };
  }

  function applyPublicProfileRealtime(row) {
    const patch = normalizePublicProfileRow(row);
    if (!patch || String(patch.user_id) === String(state.user?.id || "")) return;
    const id = String(patch.user_id);
    let touched = false;
    state.directory = state.directory.map(item => {
      if (String(item.user_id) !== id) return item;
      touched = true; return { ...item, ...patch };
    });
    state.messengerContacts = state.messengerContacts.map(item => {
      if (String(item.peer_id) !== id) return item;
      touched = true; return { ...item, ...patch, peer_id:item.peer_id };
    });
    NTS.avatar?.acceptRemote?.(patch);
    if (touched) {
      renderDirectory(); renderContacts(); renderMessengerPanel();
      if (state.activePeer && String(peerId(state.activePeer)) === id) {
        state.activePeer = { ...state.activePeer, ...patch };
        renderChatHeader();
      }
      if (state.floatingWindows.has(id)) updateFloatingWindowHeader(id);
    } else {
      // New/previously filtered member. Lightweight resync is enough.
      scheduleDirectoryRefresh();
    }
  }

  function subscribePublicProfiles() {
    closePublicProfileChannel();
    if (!state.user || !client()) return;
    state.publicProfileChannel = client().channel(`nts-public-profiles-${state.user.id}`)
      .on("postgres_changes", {
        event:"*", schema:"public", table:"member_public_profiles",
        // Keep Realtime payloads tiny. avatar_thumb_data can be tens of KB and does not
        // need to ride on every profile event; the Avatar Hub fetches the one changed
        // user's thumbnail immediately after the lightweight signal arrives.
        select:["user_id","display_name","avatar_url","oauth_avatar_url","avatar_object_path","avatar_revision","avatar_updated_at","role","plan","status","vip_until","updated_at"]
      }, payload => {
        if (payload?.eventType === "DELETE") return scheduleDirectoryRefresh();
        const patch = payload?.new || null;
        applyPublicProfileRealtime(patch);
        const changedId = String(patch?.user_id || "");
        if (changedId) NTS.avatar?.hydrateMembers?.([{ user_id:changedId }], { force:true }).catch?.(() => {});
      })
      .subscribe();
  }

  function subscribeMessages() {
    closeMessageChannel(); if (!state.user || !client()) return;
    state.messageChannel = client().channel(`nts-global-inbox-${state.user.id}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "direct_messages", filter: `recipient_id=eq.${state.user.id}` }, payload => handleIncomingMessage(payload.new))
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "direct_messages", filter: `sender_id=eq.${state.user.id}` }, payload => handleMessageUpdate(payload.new))
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "direct_messages", filter: `recipient_id=eq.${state.user.id}` }, payload => handleMessageUpdate(payload.new))
      .subscribe((status, error) => {
        if (status === "CHANNEL_ERROR") console.error("NTS messenger channel", error);
      });
  }

  function subscribePresence() {
    closePresenceChannel(); if (!state.user || !client()) return;
    state.presenceKey = `${state.user.id}:${Math.random().toString(36).slice(2, 9)}`;
    const channel = client().channel("nts-online-members", { config: { presence: { key: state.presenceKey } } });
    state.presenceChannel = channel;
    channel
      .on("presence", { event: "sync" }, () => {
        const raw = channel.presenceState(); const next = new Set();
        Object.values(raw || {}).flat().forEach(p => { if (p?.user_id) next.add(String(p.user_id)); });
        const unchanged = next.size === state.onlineUserIds.size && [...next].every(id => state.onlineUserIds.has(id));
        if (!unchanged) { state.onlineUserIds = next; updatePresenceUi(); }
      })
      .subscribe(async status => {
        if (status !== "SUBSCRIBED") return;
        try { await channel.track({ user_id: state.user.id, online_at: new Date().toISOString(), page: "app" }); } catch (_) {}
      });
  }

  async function sendMessageTo(member, body, { input = null } = {}) {
    if (state.sending || !member || !body?.trim()) return null;
    state.sending = true;
    try {
      const id = peerId(member);
      const { data, error } = await client().rpc("send_direct_message", { p_recipient: id, p_body: body.trim() });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (input) input.value = "";
      if (row) {
        if (state.pageOpen && state.activeTab === "chat" && String(state.activePeer?.user_id) === String(id)) appendMessage(row);
        const float = state.floatingWindows.get(String(id)); if (float) appendMessageToRoot(float.messages, row, true);
      }
      scheduleContactsRefresh(80);
      return row;
    } catch (error) {
      console.error("send message", error);
      const msg = String(error.message || error).includes("MESSAGE_RATE_LIMIT") ? "Bạn đang gửi quá nhanh. Chờ vài giây rồi thử lại." : error.message || String(error);
      toast("Không gửi được tin nhắn", msg, "error"); return null;
    } finally { state.sending = false; }
  }

  async function sendMessage(event) {
    event.preventDefault(); if (!state.activePeer) return;
    const input = $("chatMessageInput"); const body = input?.value.trim(); if (!body) return;
    const btn = $("sendChatMessage"); if (btn) btn.disabled = true;
    await sendMessageTo(state.activePeer, body, { input });
    if (btn) btn.disabled = false; input?.focus();
  }

  // -------------------------------------------------------------------------
  // Facebook-like floating Messenger
  // -------------------------------------------------------------------------
  function toggleMessengerPanel(force) {
    state.messengerPanelOpen = typeof force === "boolean" ? force : !state.messengerPanelOpen;
    $("messengerPanel")?.classList.toggle("hidden", !state.messengerPanelOpen);
    $("messengerLauncher")?.classList.toggle("active", state.messengerPanelOpen);
    if (state.messengerPanelOpen) { loadMessengerContacts({ silent: true }); renderMessengerPanel(); }
  }

  function renderMessengerPanel() {
    const root = $("messengerQuickList"); if (!root) return;
    root.replaceChildren();
    if (!state.messengerContacts.length) {
      const e = document.createElement("div"); e.className = "v38-messenger-empty"; e.innerHTML = '<strong>Chưa có cuộc trò chuyện</strong><span>Kết bạn trong Cộng đồng để bắt đầu nhắn tin.</span>'; root.append(e); return;
    }
    for (const row of state.messengerContacts) {
      const member = normalizeContact(row); const id = member.user_id;
      const btn = document.createElement("button"); btn.type = "button"; btn.className = `v38-messenger-contact${Number(row.unread_count || 0) ? " unread" : ""}`;
      btn.append(memberAvatar(member, true));
      const copy = document.createElement("span"); const top = document.createElement("strong"); top.textContent = member.display_name || "Hội viên";
      const last = document.createElement("small"); last.textContent = row.last_message ? truncate(row.last_message, 42) : roleLabel(member);
      copy.append(top, last); btn.append(copy);
      if (Number(row.unread_count || 0) > 0) { const b = document.createElement("b"); b.textContent = String(row.unread_count); btn.append(b); }
      btn.addEventListener("click", () => { toggleMessengerPanel(false); openFloatingChat(member); });
      root.append(btn);
    }
  }

  function enforceFloatingLimit() {
    const limit = IS_MOBILE ? 1 : 3;
    while (state.windowOrder.length >= limit) {
      const oldest = state.windowOrder.shift();
      if (oldest) closeFloatingWindow(oldest);
    }
  }

  async function openFloatingChat(member, { minimized = false, fromIncoming = false, load = true } = {}) {
    member = normalizeContact(member); if (!member || member.friendship_status !== "accepted") return;
    const id = String(member.user_id);
    let entry = state.floatingWindows.get(id);
    if (entry) {
      entry.minimized = Boolean(minimized);
      entry.el.classList.toggle("minimized", entry.minimized);
      entry.el.classList.remove("hidden");
      state.windowOrder = state.windowOrder.filter(x => x !== id); state.windowOrder.push(id);
      if (!entry.minimized) { await markPeerRead(id); setTimeout(() => entry.input.focus(), 30); }
      return;
    }
    enforceFloatingLimit();
    entry = buildFloatingWindow(member);
    entry.minimized = Boolean(minimized);
    entry.el.classList.toggle("minimized", entry.minimized);
    state.floatingWindows.set(id, entry); state.windowOrder.push(id);
    $("messengerWindows")?.append(entry.el);
    if (load) await loadFloatingMessages(member, entry);
    if (!entry.minimized) { await markPeerRead(id); if (!fromIncoming) setTimeout(() => entry.input.focus(), 30); }
  }

  function buildFloatingWindow(member) {
    const id = String(member.user_id);
    const el = document.createElement("section"); el.className = "v38-chat-window"; el.dataset.peerId = id;
    const header = document.createElement("header"); header.className = "v38-chat-window-head";
    const peer = document.createElement("button"); peer.type = "button"; peer.className = "v38-chat-window-peer"; peer.append(memberAvatar(member, true));
    const copy = document.createElement("span"); const strong = document.createElement("strong"); strong.textContent = member.display_name || "Hội viên"; const small = document.createElement("small"); small.textContent = roleLabel(member); copy.append(strong, small); peer.append(copy);
    const controls = document.createElement("div"); controls.className = "v38-chat-window-controls";
    const minimize = document.createElement("button"); minimize.type = "button"; minimize.title = "Thu nhỏ"; minimize.textContent = "−";
    const close = document.createElement("button"); close.type = "button"; close.title = "Đóng"; close.textContent = "×"; controls.append(minimize, close); header.append(peer, controls);
    const messages = document.createElement("div"); messages.className = "v38-floating-messages"; messages.innerHTML = '<div class="v38-float-empty">Đang tải...</div>';
    const form = document.createElement("form"); form.className = "v38-floating-composer";
    const input = document.createElement("textarea"); input.rows = 1; input.maxLength = 2000; input.placeholder = "Aa";
    const send = document.createElement("button"); send.type = "submit"; send.textContent = "➤"; send.title = "Gửi"; form.append(input, send);
    el.append(header, messages, form);
    const entry = { el, header, messages, form, input, send, member, minimized: false, closed: false };
    peer.addEventListener("click", () => toggleFloatingMinimize(id));
    minimize.addEventListener("click", () => toggleFloatingMinimize(id));
    close.addEventListener("click", () => closeFloatingWindow(id));
    form.addEventListener("submit", async event => {
      event.preventDefault(); const body = input.value.trim(); if (!body) return; send.disabled = true;
      await sendMessageTo(member, body, { input }); send.disabled = false; input.focus();
    });
    input.addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); }
    });
    return entry;
  }

  async function loadFloatingMessages(member, entry) {
    try {
      const rows = await fetchConversation(member.user_id, 50); entry.messages.replaceChildren();
      if (!rows.length) { entry.messages.innerHTML = '<div class="v38-float-empty">Bắt đầu cuộc trò chuyện.</div>'; }
      else { const frag = document.createDocumentFragment(); rows.forEach(row => frag.append(messageNode(row, true))); entry.messages.append(frag); entry.messages.scrollTop = entry.messages.scrollHeight; }
    } catch (error) {
      console.error("floating messages", error);
      entry.messages.innerHTML = `<div class="v38-float-empty"><strong>Không tải được tin nhắn</strong><span>${escapeHtml(error?.message || "Chạy migration 010 V3.11.")}</span></div>`;
    }
  }

  function toggleFloatingMinimize(id) {
    const entry = state.floatingWindows.get(String(id)); if (!entry) return;
    entry.minimized = !entry.minimized; entry.el.classList.toggle("minimized", entry.minimized);
    if (!entry.minimized) { markPeerRead(id); setTimeout(() => entry.input.focus(), 30); }
  }
  function closeFloatingWindow(id) {
    id = String(id); const entry = state.floatingWindows.get(id); if (!entry) return;
    entry.closed = true; entry.el.remove(); state.floatingWindows.delete(id); state.windowOrder = state.windowOrder.filter(x => x !== id);
  }
  function closeAllFloatingWindows() { [...state.floatingWindows.keys()].forEach(closeFloatingWindow); }
  function updateFloatingWindowHeader(id) {
    const entry = state.floatingWindows.get(String(id)); if (!entry) return;
    const small = entry.el.querySelector(".v38-chat-window-peer small"); if (small) small.textContent = roleLabel(entry.member);
    const oldAvatar = entry.el.querySelector(".v37-member-avatar");
    if (oldAvatar) oldAvatar.replaceWith(memberAvatar(entry.member, true));
  }

  function showIncomingPreview(member, row) {
    const stack = $("incomingMessageStack"); if (!stack) return;
    const card = document.createElement("button"); card.type = "button"; card.className = "v38-incoming-preview";
    card.append(memberAvatar(member, true));
    const copy = document.createElement("span"); const strong = document.createElement("strong"); strong.textContent = member.display_name || "Tin nhắn mới"; const msg = document.createElement("small"); msg.textContent = truncate(row.body, 80); copy.append(strong, msg); card.append(copy);
    card.addEventListener("click", () => { card.remove(); openFloatingChat(member); });
    stack.prepend(card);
    while (stack.children.length > 3) stack.lastElementChild?.remove();
    setTimeout(() => card.classList.add("show"), 20);
    setTimeout(() => { card.classList.remove("show"); setTimeout(() => card.remove(), 220); }, 6500);
  }

  // -------------------------------------------------------------------------
  // Feedback
  // -------------------------------------------------------------------------
  async function loadMyFeedback() {
    if (!state.user || !client()) return; const root = $("myFeedbackList"); if (root) root.innerHTML = '<div class="v37-empty-state">Đang tải...</div>';
    try {
      const { data, error } = await client().from("user_feedback").select("id,feedback_type,rating,content,status,admin_note,created_at,updated_at").eq("user_id", state.user.id).is("deleted_at", null).order("created_at", { ascending: false }).limit(50);
      if (error) throw error; renderFeedback(data || []);
    } catch (error) { console.error(error); if (root) root.innerHTML = '<div class="v37-empty-state">Không tải được phản hồi.</div>'; }
  }
  function renderFeedback(rows) {
    const root = $("myFeedbackList"); if (!root) return; root.replaceChildren();
    if (!rows.length) { const e = document.createElement("div"); e.className = "v37-empty-state"; e.textContent = "Bạn chưa gửi phản hồi nào."; root.append(e); return; }
    for (const row of rows) {
      const card = document.createElement("article"); card.className = "v37-feedback-item"; const top = document.createElement("div"); const type = document.createElement("strong"); type.textContent = ({ comment: "Bình luận", suggestion: "Đề xuất", bug: "Báo lỗi", other: "Khác" })[row.feedback_type] || row.feedback_type; const status = document.createElement("span"); status.className = `v37-feedback-status ${row.status}`; status.textContent = statusText(row.status); top.append(type, status); const p = document.createElement("p"); p.textContent = row.content; const meta = document.createElement("small"); meta.textContent = `${row.rating ? `${row.rating}/5 · ` : ""}${formatTime(row.created_at)}`; card.append(top, p, meta); if (row.admin_note) { const note = document.createElement("div"); note.className = "v37-admin-note"; note.textContent = `Admin: ${row.admin_note}`; card.append(note); } root.append(card);
    }
  }
  async function submitFeedback(event) {
    event.preventDefault(); if (!state.user || !client()) return; const content = $("feedbackContent").value.trim(); if (content.length < 2) return toast("Nội dung quá ngắn", "Hãy mô tả phản hồi rõ hơn.", "warning"); const btn = $("submitFeedbackButton"); btn.disabled = true;
    try {
      const ratingRaw = $("feedbackRating").value; const { error } = await client().from("user_feedback").insert({ user_id: state.user.id, feedback_type: $("feedbackType").value, rating: ratingRaw ? Number(ratingRaw) : null, content, status: "new" }); if (error) throw error;
      $("feedbackContent").value = ""; $("feedbackRating").value = ""; updateCharCount(); toast("Đã gửi phản hồi", "Cảm ơn bạn. Quản trị viên sẽ thấy phản hồi trong Trung tâm quản trị.", "success"); await loadMyFeedback();
    } catch (error) { console.error(error); toast("Không gửi được phản hồi", error.message || String(error), "error"); }
    finally { btn.disabled = false; }
  }
  function updateCharCount() { if ($("feedbackCharCount")) $("feedbackCharCount").textContent = `${$("feedbackContent")?.value.length || 0} / 3000`; }

  function scheduleDirectoryRefresh() { clearTimeout(state.refreshTimer); state.refreshTimer = setTimeout(() => { if (state.pageOpen) loadDirectory($("communityMemberSearch")?.value || ""); loadMessengerContacts({ silent: true }); }, 280); }
  function subscribeFriendships() {
    closeFriendshipChannel(); if (!state.user || !client()) return;
    state.friendshipChannel = client().channel(`nts-friends-${state.user.id}`).on("postgres_changes", { event: "*", schema: "public", table: "friendships" }, scheduleDirectoryRefresh).subscribe();
  }

  function stopAvatarRefresh() {
    clearInterval(state.avatarRefreshTimer); state.avatarRefreshTimer = null;
  }
  function startAvatarRefresh() {
    stopAvatarRefresh();
    state.avatarRefreshTimer = setInterval(() => {
      if (!state.user || document.visibilityState !== "visible") return;
      if (state.pageOpen) loadDirectory($("communityMemberSearch")?.value || "");
      loadMessengerContacts({ silent:true });
    }, 120000);
  }

  function startGlobalRealtime() {
    if (!state.user || !client()) return;
    $("messengerDock")?.classList.remove("hidden");
    subscribeMessages(); subscribePresence(); subscribePublicProfiles(); loadMessengerContacts({ silent: true }); startAvatarRefresh();
  }
  function stopGlobalRealtime() {
    closeMessageChannel(); closePresenceChannel(); closePublicProfileChannel(); closeFriendshipChannel(); closeAllFloatingWindows(); stopAvatarRefresh();
    state.directoryRequestId += 1; state.contactsRequestId += 1;
    state.messengerContacts = []; state.unread = 0; renderUnread(); toggleMessengerPanel(false); $("messengerDock")?.classList.add("hidden");
  }
  function enterCommunity() {
    if (!state.user) return; state.pageOpen = true; loadDirectory($("communityMemberSearch")?.value || ""); loadMessengerContacts({ silent: true }); subscribeFriendships(); if (state.activeTab === "feedback") loadMyFeedback();
  }
  function leaveCommunity() { state.pageOpen = false; closeFriendshipChannel(); }

  function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[c]); }

  document.querySelectorAll(".v37-community-tab").forEach(btn => btn.addEventListener("click", () => setTab(btn.dataset.communityTab)));
  $("communityMemberSearch")?.addEventListener("input", e => { clearTimeout(state.searchTimer); state.searchTimer = setTimeout(() => loadDirectory(e.target.value), 250); });
  $("chatComposer")?.addEventListener("submit", sendMessage);
  $("feedbackForm")?.addEventListener("submit", submitFeedback);
  $("feedbackContent")?.addEventListener("input", updateCharCount);
  $("refreshFeedbackButton")?.addEventListener("click", loadMyFeedback);
  $("messengerLauncher")?.addEventListener("click", () => toggleMessengerPanel());
  $("messengerPanelClose")?.addEventListener("click", () => toggleMessengerPanel(false));

  window.addEventListener("nts:page-changed", e => { const page = e.detail?.pageId; if (page === "communityPage") enterCommunity(); else leaveCommunity(); });
  window.addEventListener("nts:profile-saved", () => {
    if (!state.user) return;
    // Refresh visible community surfaces so saved avatars/crops propagate immediately.
    loadDirectory($("communityMemberSearch")?.value || "");
    loadMessengerContacts({ silent: true });
  });
  window.addEventListener("nts:avatar-resolved", e => {
    const member = e.detail?.member;
    if (member?.user_id) applyPublicProfileRealtime(member);
  });

  window.addEventListener("nts:auth-user", e => {
    state.user = e.detail?.user || null;
    if (!state.user) { stopGlobalRealtime(); state.directory = []; closeChat(); }
    else startGlobalRealtime();
  });
  window.addEventListener("nts:membership-updated", e => { state.account = e.detail?.account || null; });
  window.addEventListener("beforeunload", () => stopGlobalRealtime());


  window.addEventListener("visibilitychange", () => {
    if (!state.user || document.visibilityState !== "visible") return;
    if (state.pageOpen) loadDirectory($("communityMemberSearch")?.value || "");
    loadMessengerContacts({ silent:true });
  });
  window.addEventListener("online", () => { if (state.user) startGlobalRealtime(); });

  if (NTS.currentUser) { state.user = NTS.currentUser; startGlobalRealtime(); }
  NTS.community = { state, loadDirectory, loadMessengerContacts, openChat, openFloatingChat, setTab, toggleMessengerPanel };
})();
