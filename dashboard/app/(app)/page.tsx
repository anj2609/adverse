"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Spinner } from "@/components/ui";

/** The portal opens on the apps list: that is where everything starts. */
export default function Home() {
  const router = useRouter();
  useEffect(() => { router.replace("/applications"); }, [router]);
  return <Spinner />;
}
