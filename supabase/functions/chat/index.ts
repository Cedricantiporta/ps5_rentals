// Supabase Edge Function: powers the public site's chat widget.
// Deploy via the Supabase dashboard (Edge Functions -> Create function ->
// paste this file) or the CLI (`supabase functions deploy chat`).
// Requires one secret: GEMINI_API_KEY (Project Settings -> Edge Functions
// -> Secrets). SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are already
// available to every Edge Function automatically -- nothing to set for
// those.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DAILY_LIMIT = 20;
const GEMINI_MODEL = "gemini-2.5-flash";
const MAX_MESSAGE_LEN = 500;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SYSTEM_PROMPT = `You are the customer-support chat assistant for June Digitals, a PS5 game rental service in the Philippines.

Only answer questions about: this business's game rentals, prices, availability, how Trophy vs Non-Trophy access works, how swapping games works, GCash payment, and rental rules. Friendly greetings/small talk are fine too.

If asked about anything unrelated to June Digitals' rental service (general trivia, coding help, other businesses, etc.), politely decline and steer back, e.g. "I can only help with June Digitals game rentals -- ask me about availability, pricing, or how rentals work!"

Never invent game titles, prices, or availability -- only use the CATALOG DATA below, which is live and accurate right now. If a customer asks about a game not listed there, say it's not currently in the catalog.

Keep answers short (2-4 sentences), friendly, and reply in the same language the customer used (English or Tagalog/Taglish are both fine).

FAQ:
- Trophy Slot: played on the customer's own PSN profile, trophies and saves stay theirs.
- Non-Trophy Slot: played on the rented game's own profile, same full game access either way.
- Weekly plan: 7 days, includes 1 swap, 24h cooldown after a completed swap.
- Monthly plan: 30 days, includes multiple swaps, 24h cooldown after each completed swap.
- Payment: GCash, confirmed manually via Messenger before the rental is activated.
- To rent: use the site's Rent button to start, then message June Digitals on Messenger to arrange payment.`;

function catalogText(games: any[]): string {
  return games.map((g) => {
    if (g.status === "upcoming") {
      return `${g.title} (PRE-RESERVE, releases ${g.release_date}): Trophy slot ${g.trophy_reservation_status}, Non-Trophy slot ${g.nontrophy_reservation_status}. Weekly ₱${g.trophy_weekly}, Monthly ₱${g.trophy_monthly}.`;
    }
    return `${g.title}: Trophy ${g.trophy_available ? "AVAILABLE" : "FULL"} (Weekly ₱${g.trophy_weekly} / Monthly ₱${g.trophy_monthly}), Non-Trophy ${g.nontrophy_available ? "AVAILABLE" : "FULL"} (Weekly ₱${g.nontrophy_weekly} / Monthly ₱${g.nontrophy_monthly}).`;
  }).join("\n");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const { clientId, message } = await req.json();
    if (!clientId || typeof clientId !== "string" || !message || typeof message !== "string") {
      return new Response(JSON.stringify({ error: "Missing clientId or message." }), {
        status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
    if (message.length > MAX_MESSAGE_LEN) {
      return new Response(JSON.stringify({ error: "Message too long." }), {
        status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const today = new Date().toISOString().slice(0, 10);
    const { data: usage } = await supabase
      .from("chat_usage").select("count").eq("client_id", clientId).eq("day", today).maybeSingle();
    const currentCount = usage?.count || 0;

    if (currentCount >= DAILY_LIMIT) {
      return new Response(JSON.stringify({
        reply: "You've hit today's chat limit (20 messages). Please try again tomorrow, or message us directly on Messenger!",
        limited: true, remaining: 0,
      }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    const { data: games } = await supabase.from("games").select(
      "title,status,release_date,trophy_available,trophy_weekly,trophy_monthly,trophy_reservation_status,nontrophy_available,nontrophy_weekly,nontrophy_monthly,nontrophy_reservation_status"
    );

    const prompt = `${SYSTEM_PROMPT}\n\nCATALOG DATA (live, right now):\n${catalogText(games || [])}\n\nCustomer message: ${message}`;

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${Deno.env.get("GEMINI_API_KEY")}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      }
    );
    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error("Gemini API error", geminiRes.status, errText);
      return new Response(JSON.stringify({ error: "Chat is temporarily unavailable. Please message us on Messenger.", detail: errText }), {
        status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
    const geminiData = await geminiRes.json();
    const reply = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ||
      "Sorry, I couldn't process that -- please try again or message us on Messenger.";

    await supabase.from("chat_usage").upsert(
      { client_id: clientId, day: today, count: currentCount + 1 },
      { onConflict: "client_id,day" }
    );
    await supabase.from("chat_log").insert({ client_id: clientId, message, reply });

    return new Response(JSON.stringify({ reply, remaining: DAILY_LIMIT - (currentCount + 1) }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Unhandled error", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
