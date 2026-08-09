(() => {
  "use strict";
  const $=id=>document.getElementById(id);const NTS=window.NTS=window.NTS||{};
  const state={editingProfile:false,account:null};

  function setProfileEditing(editing){state.editingProfile=Boolean(editing);const panel=document.querySelector(".v37-profile-edit-panel");panel?.classList.toggle("hidden",!state.editingProfile);$("profileEditArea")?.classList.toggle("editing",state.editingProfile);$("editProfileButton")?.classList.toggle("hidden",state.editingProfile);$("saveProfileButtonTop")?.classList.add("hidden");if(state.editingProfile){setTimeout(()=>panel?.scrollIntoView({behavior:"smooth",block:"start"}),40);} }
  $("editProfileButton")?.addEventListener("click",()=>setProfileEditing(true));
  $("cancelProfileEditButton")?.addEventListener("click",()=>{setProfileEditing(false);NTS.profile?.refresh?.({silent:true});});
  window.addEventListener("nts:profile-saved",()=>setProfileEditing(false));
  window.addEventListener("nts:page-changed",e=>{if(e.detail?.pageId!=="profilePage")setProfileEditing(false);});

  function applyRoleNavigation(account){state.account=account||null;const admin=account?.role==="admin";document.querySelectorAll(".vip-nav,.vip-menu-item").forEach(el=>el.classList.toggle("hidden",admin));$("upgradeCta")?.classList.toggle("hidden",admin);if($("adminNavButton"))$("adminNavButton").classList.toggle("hidden",!admin);if($("adminQuickMenu"))$("adminQuickMenu").classList.toggle("hidden",!admin);
    if(admin&&!$("vipPage")?.classList.contains("hidden")){document.querySelector('[data-page="adminPage"]')?.click();}
  }
  window.addEventListener("nts:membership-updated",e=>applyRoleNavigation(e.detail?.account));
  if(NTS.membership?.state?.account)applyRoleNavigation(NTS.membership.state.account);

  // Range sliders keep the Bordeaux / pink gradient instead of turning white.
  function paintRange(el){if(!el||el.type!=="range")return;const min=Number(el.min||0),max=Number(el.max||100),val=Number(el.value||0);const pct=max>min?((val-min)/(max-min))*100:0;el.style.setProperty("--v37-range-progress",`${Math.max(0,Math.min(100,pct))}%`);}
  document.querySelectorAll('input[type="range"]').forEach(paintRange);
  document.addEventListener("input",e=>{if(e.target?.matches?.('input[type="range"]'))paintRange(e.target);});

  // Improve textarea autosize only where it helps; avoids layout work in Studio canvas.
  const resizeChat=el=>{if(!el)return;el.style.height="auto";el.style.height=`${Math.min(128,Math.max(42,el.scrollHeight))}px`;};
  $("chatMessageInput")?.addEventListener("input",e=>resizeChat(e.target));
})();
