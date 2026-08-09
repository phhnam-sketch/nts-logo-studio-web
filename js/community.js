(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const NTS = window.NTS = window.NTS || {};
  const state = {
    user: null,
    account: null,
    pageOpen: false,
    activeTab: "people",
    directory: [],
    activePeer: null,
    friendshipChannel: null,
    messageChannel: null,
    searchTimer: null,
    refreshTimer: null,
    sending: false,
    loadingMessages: false,
    unread: 0
  };
  const client = () => NTS.supabase;
  const toast = (t, m, k = "info", d) => NTS.showToast?.(t, m, k, d);
  const fallbackAvatar = () => window.APP_CONFIG?.BRAND?.defaultAvatarUrl || "assets/brand/avatar-default.png";

  function roleLabel(member) {
    if (member?.role === "admin") return "ADMIN";
    if (member?.is_vip) return "VIP";
    return "FREE";
  }
  function roleClass(member) {
    return member?.role === "admin" ? "admin" : member?.is_vip ? "vip" : "free";
  }
  function initials(name) {
    const parts = String(name || "Hội viên").trim().split(/\s+/).filter(Boolean);
    return (parts[0]?.[0] || "H") + (parts.length > 1 ? parts.at(-1)[0] : "");
  }
  function formatTime(value) {
    if (!value) return "";
    try { return new Intl.DateTimeFormat("vi-VN", { hour:"2-digit", minute:"2-digit", day:"2-digit", month:"2-digit" }).format(new Date(value)); }
    catch (_) { return ""; }
  }
  function statusText(status) {
    const map = { new:"Mới", reviewing:"Đang xem", planned:"Đã lên kế hoạch", resolved:"Đã xử lý", rejected:"Từ chối", archived:"Lưu trữ" };
    return map[status] || status || "—";
  }

  function setTab(tab) {
    state.activeTab = ["people","chat","feedback"].includes(tab) ? tab : "people";
    document.querySelectorAll(".v37-community-tab").forEach(btn => btn.classList.toggle("active", btn.dataset.communityTab === state.activeTab));
    [["people","communityPeoplePanel"],["chat","communityChatPanel"],["feedback","communityFeedbackPanel"]].forEach(([name,id]) => $(id)?.classList.toggle("hidden", name !== state.activeTab));
    if (state.activeTab === "chat") renderContacts();
    if (state.activeTab === "feedback") loadMyFeedback();
  }

  async function loadDirectory(search = "") {
    if (!state.user || !client()) return;
    try {
      const { data, error } = await client().rpc("list_member_directory", { p_search: search.trim(), p_limit: 60 });
      if (error) throw error;
      state.directory = Array.isArray(data) ? data : [];
      renderDirectory();
      renderRequests();
      renderContacts();
    } catch (error) {
      console.error("community directory", error);
      $("communityMemberList") && ($("communityMemberList").innerHTML = '<div class="v37-empty-state">Không tải được danh bạ. Hãy chạy migration 005 V3.7.</div>');
    }
  }

  function memberAvatar(member, compact = false) {
    const wrap = document.createElement("div");
    wrap.className = compact ? "v37-member-avatar compact" : "v37-member-avatar";
    const img = document.createElement("img");
    img.alt = "";
    img.decoding = "async";
    img.loading = "lazy";
    img.src = member.avatar_url || fallbackAvatar();
    img.onerror = () => { img.onerror = null; img.src = fallbackAvatar(); };
    const badge = document.createElement("span");
    badge.className = `v37-role-dot ${roleClass(member)}`;
    badge.textContent = roleLabel(member);
    badge.title = roleLabel(member);
    wrap.append(img, badge);
    return wrap;
  }

  function renderDirectory() {
    const root = $("communityMemberList");
    if (!root) return;
    root.replaceChildren();
    $("communityMemberCount") && ($("communityMemberCount").textContent = String(state.directory.length));
    const people = state.directory.filter(x => x.friendship_direction !== "incoming" || x.friendship_status !== "pending");
    if (!people.length) {
      const empty = document.createElement("div"); empty.className = "v37-empty-state"; empty.textContent = "Không tìm thấy hội viên phù hợp."; root.append(empty); return;
    }
    const frag = document.createDocumentFragment();
    for (const member of people) {
      const card = document.createElement("article");
      card.className = "v37-member-card";
      card.dataset.userId = member.user_id;
      const identity = document.createElement("div"); identity.className = "v37-member-identity";
      identity.append(memberAvatar(member));
      const copy = document.createElement("div");
      const name = document.createElement("strong"); name.textContent = member.display_name || "Hội viên";
      const meta = document.createElement("span"); meta.textContent = member.role === "admin" ? "Quản trị viên NTS" : member.is_vip ? "Hội viên VIP" : "Hội viên Free";
      copy.append(name, meta); identity.append(copy); card.append(identity);
      const actions = document.createElement("div"); actions.className = "v37-member-actions";
      if (member.friendship_status === "accepted") {
        const chat = document.createElement("button"); chat.className = "primary-button compact"; chat.type = "button"; chat.textContent = "Nhắn tin";
        chat.addEventListener("click", () => { setTab("chat"); openChat(member); });
        const remove = document.createElement("button"); remove.className = "text-button"; remove.type = "button"; remove.textContent = "Hủy kết bạn";
        remove.addEventListener("click", () => removeFriend(member));
        actions.append(chat, remove);
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
    if (!rows.length) { const e=document.createElement("div"); e.className="v37-empty-state small"; e.textContent="Chưa có lời mời."; root.append(e); return; }
    for (const member of rows) {
      const row=document.createElement("div"); row.className="v37-request-row"; row.append(memberAvatar(member,true));
      const copy=document.createElement("div"); const strong=document.createElement("strong"); strong.textContent=member.display_name; const span=document.createElement("span"); span.textContent=`${roleLabel(member)} · muốn kết bạn`; copy.append(strong,span); row.append(copy);
      const acts=document.createElement("div");
      const yes=document.createElement("button"); yes.className="primary-button mini"; yes.textContent="✓"; yes.title="Chấp nhận"; yes.type="button"; yes.addEventListener("click",()=>respondFriend(member,"accept"));
      const no=document.createElement("button"); no.className="secondary-button mini"; no.textContent="×"; no.title="Từ chối"; no.type="button"; no.addEventListener("click",()=>respondFriend(member,"decline"));
      acts.append(yes,no); row.append(acts); root.append(row);
    }
  }

  async function sendFriend(member, button) {
    if (!client()) return;
    button.disabled=true;
    try { const { error }=await client().rpc("send_friend_request",{p_target:member.user_id}); if(error)throw error; toast("Đã gửi lời mời",`Đã gửi lời mời kết bạn tới ${member.display_name}.`,`success`); await loadDirectory($("communityMemberSearch")?.value||""); }
    catch(error){ console.error(error); toast("Không gửi được lời mời",error.message||String(error),"error"); }
    finally{button.disabled=false;}
  }
  async function respondFriend(member, action) {
    try { const { error }=await client().rpc("respond_friend_request",{p_friendship:member.friendship_id,p_action:action}); if(error)throw error; toast(action==="accept"?"Đã kết bạn":"Đã từ chối", action==="accept"?`Bạn và ${member.display_name} có thể nhắn tin.`:"Lời mời đã được từ chối.",action==="accept"?"success":"info"); await loadDirectory($("communityMemberSearch")?.value||""); }
    catch(error){console.error(error);toast("Không cập nhật được lời mời",error.message||String(error),"error");}
  }
  async function removeFriend(member) {
    const ok = await NTS.dialog?.confirm?.({title:"Hủy kết bạn?",message:`Bạn sẽ không thể nhắn tin với ${member.display_name} cho đến khi kết bạn lại.`,confirmText:"Hủy kết bạn",danger:true});
    if (!ok) return;
    try { const {error}=await client().rpc("remove_friendship",{p_friendship:member.friendship_id}); if(error)throw error; if(state.activePeer?.user_id===member.user_id) closeChat(); await loadDirectory($("communityMemberSearch")?.value||""); }
    catch(error){toast("Không hủy được kết bạn",error.message||String(error),"error");}
  }

  function renderContacts() {
    const root=$("chatContactList"); if(!root)return; root.replaceChildren();
    const friends=state.directory.filter(x=>x.friendship_status==="accepted");
    if(!friends.length){const e=document.createElement("div");e.className="v37-empty-state small";e.textContent="Chưa có bạn bè. Hãy gửi lời mời ở tab Hội viên.";root.append(e);return;}
    for(const member of friends){
      const btn=document.createElement("button");btn.type="button";btn.className="v37-chat-contact"+(state.activePeer?.user_id===member.user_id?" active":"");
      btn.append(memberAvatar(member,true));const copy=document.createElement("span");const strong=document.createElement("strong");strong.textContent=member.display_name;const small=document.createElement("small");small.textContent=roleLabel(member);copy.append(strong,small);btn.append(copy);btn.addEventListener("click",()=>openChat(member));root.append(btn);
    }
  }

  function closeMessageChannel(){ if(state.messageChannel&&client()){client().removeChannel(state.messageChannel).catch?.(()=>{});} state.messageChannel=null; }
  function closeFriendshipChannel(){ if(state.friendshipChannel&&client()){client().removeChannel(state.friendshipChannel).catch?.(()=>{});} state.friendshipChannel=null; }
  function closeChat(){ state.activePeer=null; $("chatMessageInput") && ($("chatMessageInput").disabled=true); $("sendChatMessage") && ($("sendChatMessage").disabled=true); $("chatMessages")?.replaceChildren(Object.assign(document.createElement("div"),{className:"v37-chat-empty",textContent:"Chọn một hội viên để trò chuyện."})); renderContacts(); }

  async function openChat(member) {
    if (!member || member.friendship_status !== "accepted") return;
    state.activePeer=member; renderContacts();
    const head=$("chatRoomHeader"); if(head){head.replaceChildren();const left=document.createElement("div");left.className="v37-chat-peer";left.append(memberAvatar(member,true));const copy=document.createElement("div");const strong=document.createElement("strong");strong.textContent=member.display_name;const small=document.createElement("span");small.textContent=member.role==="admin"?"Quản trị viên · Tin nhắn riêng tư":`${roleLabel(member)} · Tin nhắn riêng tư`;copy.append(strong,small);left.append(copy);head.append(left);}
    $("chatMessageInput") && ($("chatMessageInput").disabled=false); $("sendChatMessage") && ($("sendChatMessage").disabled=false);
    await loadMessages(); setTimeout(()=>$("chatMessageInput")?.focus(),30);
  }

  async function loadMessages(){
    if(!state.user||!state.activePeer||state.loadingMessages)return;state.loadingMessages=true;
    const root=$("chatMessages"); if(root)root.innerHTML='<div class="v37-chat-empty">Đang tải tin nhắn...</div>';
    try{
      const u=state.user.id,p=state.activePeer.user_id;
      const {data,error}=await client().from("direct_messages").select("id,sender_id,recipient_id,body,created_at,read_at").is("deleted_at",null).or(`and(sender_id.eq.${u},recipient_id.eq.${p}),and(sender_id.eq.${p},recipient_id.eq.${u})`).order("created_at",{ascending:true}).limit(80);
      if(error)throw error; renderMessages(data||[]); await client().rpc("mark_messages_read",{p_peer:p}).catch(()=>{}); await loadUnreadCount();
    }catch(error){console.error(error);if(root)root.innerHTML='<div class="v37-chat-empty">Không tải được tin nhắn. Kiểm tra migration 005.</div>';}
    finally{state.loadingMessages=false;}
  }
  function renderMessages(rows){const root=$("chatMessages");if(!root)return;root.replaceChildren();if(!rows.length){const e=document.createElement("div");e.className="v37-chat-empty";e.textContent="Chưa có tin nhắn. Hãy gửi lời chào đầu tiên.";root.append(e);return;}const frag=document.createDocumentFragment();for(const row of rows)frag.append(messageNode(row));root.append(frag);root.scrollTop=root.scrollHeight;}
  function messageNode(row){const mine=row.sender_id===state.user?.id;const wrap=document.createElement("article");wrap.className=`v37-message ${mine?"mine":"theirs"}`;wrap.dataset.messageId=String(row.id);const body=document.createElement("p");body.textContent=row.body;const meta=document.createElement("span");meta.textContent=formatTime(row.created_at)+(mine&&row.read_at?" · Đã xem":"");wrap.append(body,meta);return wrap;}
  function appendMessage(row){const root=$("chatMessages");if(!root||!row)return;if(root.querySelector(`[data-message-id="${CSS.escape(String(row.id))}"]`))return;root.querySelector(".v37-chat-empty")?.remove();root.append(messageNode(row));root.scrollTop=root.scrollHeight;}

  function renderUnread(){const badge=$("communityUnreadBadge");if(!badge)return;badge.textContent=String(state.unread||0);badge.classList.toggle("hidden",!state.unread);}
  async function loadUnreadCount(){if(!state.user||!client())return;try{const{count,error}=await client().from("direct_messages").select("id",{count:"exact",head:true}).eq("recipient_id",state.user.id).is("read_at",null).is("deleted_at",null);if(error)throw error;state.unread=Number(count||0);renderUnread();}catch(error){console.warn("unread count",error);}}
  function subscribeMessages(){closeMessageChannel();if(!state.user||!client())return;state.messageChannel=client().channel(`nts-inbox-${state.user.id}`).on("postgres_changes",{event:"INSERT",schema:"public",table:"direct_messages",filter:`recipient_id=eq.${state.user.id}`},payload=>{const row=payload.new;if(state.activePeer?.user_id===row?.sender_id&&state.activeTab==="chat"){appendMessage(row);client().rpc("mark_messages_read",{p_peer:row.sender_id}).then(()=>loadUnreadCount()).catch(()=>{});}else{state.unread+=1;renderUnread();toast("Tin nhắn mới","Bạn vừa nhận một tin nhắn mới trong Cộng đồng.","info",2800);}}).subscribe();}

  async function sendMessage(event){event.preventDefault();if(state.sending||!state.activePeer)return;const input=$("chatMessageInput");const body=input?.value.trim();if(!body)return;state.sending=true;$("sendChatMessage").disabled=true;try{const{data,error}=await client().rpc("send_direct_message",{p_recipient:state.activePeer.user_id,p_body:body});if(error)throw error;input.value="";const row=Array.isArray(data)?data[0]:data;if(row)appendMessage(row);}catch(error){console.error(error);const msg=String(error.message||error).includes("MESSAGE_RATE_LIMIT")?"Bạn đang gửi quá nhanh. Chờ vài giây rồi thử lại.":error.message||String(error);toast("Không gửi được tin nhắn",msg,"error");}finally{state.sending=false;$("sendChatMessage").disabled=false;input?.focus();}}

  async function loadMyFeedback(){if(!state.user||!client())return;const root=$("myFeedbackList");if(root)root.innerHTML='<div class="v37-empty-state">Đang tải...</div>';try{const{data,error}=await client().from("user_feedback").select("id,feedback_type,rating,content,status,admin_note,created_at,updated_at").eq("user_id",state.user.id).is("deleted_at",null).order("created_at",{ascending:false}).limit(50);if(error)throw error;renderFeedback(data||[]);}catch(error){console.error(error);if(root)root.innerHTML='<div class="v37-empty-state">Không tải được phản hồi.</div>';}}
  function renderFeedback(rows){const root=$("myFeedbackList");if(!root)return;root.replaceChildren();if(!rows.length){const e=document.createElement("div");e.className="v37-empty-state";e.textContent="Bạn chưa gửi phản hồi nào.";root.append(e);return;}for(const row of rows){const card=document.createElement("article");card.className="v37-feedback-item";const top=document.createElement("div");const type=document.createElement("strong");type.textContent=({comment:"Bình luận",suggestion:"Đề xuất",bug:"Báo lỗi",other:"Khác"})[row.feedback_type]||row.feedback_type;const status=document.createElement("span");status.className=`v37-feedback-status ${row.status}`;status.textContent=statusText(row.status);top.append(type,status);const p=document.createElement("p");p.textContent=row.content;const meta=document.createElement("small");meta.textContent=`${row.rating?`${row.rating}/5 · `:""}${formatTime(row.created_at)}`;card.append(top,p,meta);if(row.admin_note){const note=document.createElement("div");note.className="v37-admin-note";note.textContent=`Admin: ${row.admin_note}`;card.append(note);}root.append(card);}}
  async function submitFeedback(event){event.preventDefault();if(!state.user||!client())return;const content=$("feedbackContent").value.trim();if(content.length<2)return toast("Nội dung quá ngắn","Hãy mô tả phản hồi rõ hơn.","warning");const btn=$("submitFeedbackButton");btn.disabled=true;try{const ratingRaw=$("feedbackRating").value;const{error}=await client().from("user_feedback").insert({user_id:state.user.id,feedback_type:$("feedbackType").value,rating:ratingRaw?Number(ratingRaw):null,content,status:"new"});if(error)throw error;$("feedbackContent").value="";$("feedbackRating").value="";updateCharCount();toast("Đã gửi phản hồi","Cảm ơn bạn. Quản trị viên sẽ thấy phản hồi trong Trung tâm quản trị.","success");await loadMyFeedback();}catch(error){console.error(error);toast("Không gửi được phản hồi",error.message||String(error),"error");}finally{btn.disabled=false;}}
  function updateCharCount(){if($("feedbackCharCount"))$("feedbackCharCount").textContent=`${$("feedbackContent")?.value.length||0} / 3000`;}

  function scheduleDirectoryRefresh(){clearTimeout(state.refreshTimer);state.refreshTimer=setTimeout(()=>{if(state.pageOpen)loadDirectory($("communityMemberSearch")?.value||"");},280);}
  function subscribeFriendships(){closeFriendshipChannel();if(!state.user||!client())return;state.friendshipChannel=client().channel(`nts-friends-${state.user.id}`).on("postgres_changes",{event:"*",schema:"public",table:"friendships"},scheduleDirectoryRefresh).subscribe();}
  function enterCommunity(){if(!state.user)return;state.pageOpen=true;loadDirectory($("communityMemberSearch")?.value||"");loadUnreadCount();subscribeFriendships();subscribeMessages();if(state.activeTab==="feedback")loadMyFeedback();}
  function leaveCommunity(){state.pageOpen=false;closeFriendshipChannel();closeMessageChannel();}

  document.querySelectorAll(".v37-community-tab").forEach(btn=>btn.addEventListener("click",()=>setTab(btn.dataset.communityTab)));
  $("communityMemberSearch")?.addEventListener("input",e=>{clearTimeout(state.searchTimer);state.searchTimer=setTimeout(()=>loadDirectory(e.target.value),250);});
  $("chatComposer")?.addEventListener("submit",sendMessage);
  $("feedbackForm")?.addEventListener("submit",submitFeedback);
  $("feedbackContent")?.addEventListener("input",updateCharCount);
  $("refreshFeedbackButton")?.addEventListener("click",loadMyFeedback);

  window.addEventListener("nts:page-changed",e=>{const page=e.detail?.pageId;if(page==="communityPage")enterCommunity();else leaveCommunity();});
  window.addEventListener("nts:auth-user",e=>{state.user=e.detail?.user||null;if(!state.user){leaveCommunity();state.directory=[];closeChat();}});
  window.addEventListener("nts:membership-updated",e=>{state.account=e.detail?.account||null;});
  window.addEventListener("beforeunload",()=>{closeFriendshipChannel();closeMessageChannel();});

  if(NTS.currentUser)state.user=NTS.currentUser;
  NTS.community={state,loadDirectory,openChat,setTab};
})();
