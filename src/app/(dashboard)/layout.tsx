import { redirect } from "next/navigation";
import { getCurrentSession } from "@/modules/auth/service";
import { DashboardShell } from "@/components/dashboard/DashboardShell";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const sessionContext = await getCurrentSession();

  if (!sessionContext) {
    redirect("/login");
  }

  return <DashboardShell user={sessionContext.user}>{children}</DashboardShell>;
}
