import { getChatGPTUser } from "./chatgpt-auth";
import StudioDashboard from "./components/StudioDashboard";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getChatGPTUser();

  return (
    <StudioDashboard
      userName={user?.displayName ?? "Tài khoản demo"}
      signedIn={Boolean(user)}
    />
  );
}
