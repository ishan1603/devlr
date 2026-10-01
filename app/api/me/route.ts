import { NextRequest, NextResponse } from "next/server";
import { ProfileUpdate, getMe, updateMe } from "@/lib/profile";

export async function GET() {
  const me = await getMe();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  return NextResponse.json(me);
}

export async function PUT(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = ProfileUpdate.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid settings" },
      { status: 400 }
    );
  }

  const error = await updateMe(parsed.data);
  if (error === "Not signed in") return NextResponse.json({ error }, { status: 401 });
  if (error) return NextResponse.json({ error }, { status: 500 });

  return NextResponse.json(await getMe());
}
