(() => {
  "use strict";
  const $=id=>document.getElementById(id);
  const NTS=window.NTS=window.NTS||{};
  const cfg=window.APP_CONFIG||{};
  const state={user:null,profile:null,saving:false};
  const toast=(t,m,k="info",d)=>NTS.showToast?.(t,m,k,d);
  const client=()=>NTS.supabase;

  function defaults(){return {display_name:"Người dùng",bio:"",avatar_url:null,cover_url:null};}
  function safe(v){return String(v??"");}

  async function refresh(){
    if (!state.user||!client()) return;
    try{
      const {data,error}=await client().from("profiles").select("*").eq("id",state.user.id).single();
      if(error) throw error;
      state.profile={...defaults(),...data};
      render();
    }catch(error){console.error(error);toast("Không tải được hồ sơ",error.message||String(error),"error");}
  }

  function render(){
    const p=state.profile||defaults();
    const brand=cfg.BRAND||{};
    if($("profileDisplayName")) $("profileDisplayName").value=p.display_name||"";
    if($("profileBio")) $("profileBio").value=p.bio||"";
    if($("profileEmail")) $("profileEmail").value=state.user?.email||"";
    if($("profileNameHero")) $("profileNameHero").textContent=p.display_name||"Người dùng";
    if($("profileEmailHero")) $("profileEmailHero").textContent=state.user?.email||"";
    const avatar=p.avatar_url||state.user?.user_metadata?.avatar_url||state.user?.user_metadata?.picture||brand.defaultAvatarUrl||"assets/brand/avatar-default.svg";
    const cover=p.cover_url||brand.defaultCoverUrl||"assets/brand/cover-default.svg";
    if($("profileAvatarPreview")) $("profileAvatarPreview").src=avatar;
    if($("profileCoverPreview")) $("profileCoverPreview").src=cover;
    if($("userAvatarImage")){ $("userAvatarImage").src=avatar; $("userAvatarImage").classList.remove("hidden"); $("userAvatarFallback")?.classList.add("hidden"); }
    if($("userDisplayName")) $("userDisplayName").textContent=p.display_name;
    if($("menuDisplayName")) $("menuDisplayName").textContent=p.display_name;
  }

  async function uploadProfileMedia(file,kind){
    if(!file) return null;
    if(!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error("Chỉ nhận JPG, PNG hoặc WebP.");
    if(file.size>5*1024*1024) throw new Error("Ảnh hồ sơ tối đa 5 MB.");
    const ext=(file.name.split(".").pop()||"jpg").replace(/[^a-z0-9]/gi,"").toLowerCase();
    const path=`${state.user.id}/${kind}-${Date.now()}.${ext}`;
    const {error}=await client().storage.from("profile-media").upload(path,file,{upsert:false,contentType:file.type});
    if(error) throw error;
    const {data}=client().storage.from("profile-media").getPublicUrl(path);
    return data.publicUrl;
  }

  async function save(event){
    event.preventDefault();
    if(state.saving) return;
    state.saving=true;
    const btn=$("saveProfileButton"); if(btn) btn.disabled=true;
    try{
      const displayName=$("profileDisplayName").value.trim();
      const bio=$("profileBio").value.trim();
      if(!displayName||displayName.length>60) throw new Error("Tên hiển thị phải từ 1 đến 60 ký tự.");
      if(bio.length>500) throw new Error("Bio tối đa 500 ký tự.");
      let avatarUrl=state.profile?.avatar_url||null, coverUrl=state.profile?.cover_url||null;
      const avatarFile=$("profileAvatarInput")?.files?.[0];
      const coverFile=$("profileCoverInput")?.files?.[0];
      if(avatarFile) avatarUrl=await uploadProfileMedia(avatarFile,"avatar");
      if(coverFile) coverUrl=await uploadProfileMedia(coverFile,"cover");
      const {error}=await client().from("profiles").update({display_name:displayName,bio,avatar_url:avatarUrl,cover_url:coverUrl}).eq("id",state.user.id);
      if(error) throw error;
      await client().auth.updateUser({data:{display_name:displayName,avatar_url:avatarUrl||undefined}}).catch(()=>{});
      toast("Đã cập nhật hồ sơ","Ảnh đại diện, ảnh bìa và thông tin cá nhân đã được lưu.","success");
      $("profileAvatarInput").value=""; $("profileCoverInput").value="";
      await refresh();
    }catch(error){console.error(error);toast("Không lưu được hồ sơ",error.message||String(error),"error",7000);}
    finally{state.saving=false;if(btn)btn.disabled=false;}
  }

  $("profileForm")?.addEventListener("submit",save);
  $("profileAvatarInput")?.addEventListener("change",e=>{const f=e.target.files?.[0];if(f){const u=URL.createObjectURL(f);$("profileAvatarPreview").src=u;setTimeout(()=>URL.revokeObjectURL(u),5000);}});
  $("profileCoverInput")?.addEventListener("change",e=>{const f=e.target.files?.[0];if(f){const u=URL.createObjectURL(f);$("profileCoverPreview").src=u;setTimeout(()=>URL.revokeObjectURL(u),5000);}});

  window.addEventListener("nts:auth-user",e=>{state.user=e.detail.user||null;if(state.user)refresh();else state.profile=null;});
  NTS.profile={state,refresh};
  if(NTS.currentUser){state.user=NTS.currentUser;refresh();}
})();
