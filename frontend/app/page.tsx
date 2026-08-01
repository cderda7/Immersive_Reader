import { Suspense } from "react";
import { ReadingScreen } from "@/components/ReadingScreen";

export default function Home() {
  return (
    <main className="page">
      {/* ReadingScreen reads ?book=/?chapter=/?grade= via useSearchParams
          (see its auto-load effect) -- Next requires a Suspense boundary
          around any component using that hook so the rest of the route
          can still prerender instead of opting the whole page into
          client-only rendering. */}
      <Suspense fallback={null}>
        <ReadingScreen />
      </Suspense>
    </main>
  );
}
