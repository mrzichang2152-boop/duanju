"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";

export default function ScriptPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();

  useEffect(() => {
    if (params.id) {
      router.replace(`/projects/${params.id}/script/input`);
    }
  }, [params.id, router]);

  return null;
}
