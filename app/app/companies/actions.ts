"use server";

import { revalidatePath } from "next/cache";
import { getMe } from "@/lib/profile";
import { createClient } from "@/lib/server";

export async function toggleFollowCompany(companyId: string, isFollowing: boolean) {
  const me = await getMe();
  if (!me) throw new Error("Not authenticated");

  const supabase = await createClient();

  if (isFollowing) {
    // Unfollow
    await supabase
      .from("user_companies")
      .delete()
      .match({ user_id: me.profile.user_id, company_id: companyId });
  } else {
    // Follow
    await supabase
      .from("user_companies")
      .insert({ user_id: me.profile.user_id, company_id: companyId });
  }

  revalidatePath("/app/companies");
}
