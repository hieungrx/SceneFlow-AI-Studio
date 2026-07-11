import { NextResponse } from "next/server";
import { getChatGPTUser } from "../../chatgpt-auth";
import { ensureUser, getCreditBalance } from "../../../lib/repository";

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  await ensureUser(user.email, user.displayName);
  return NextResponse.json({ balance: await getCreditBalance(user.email) });
}
