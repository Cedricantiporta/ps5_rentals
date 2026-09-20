// Supabase Edge Function: powers the public site's chat widget.
// Deploy via the Supabase dashboard (Edge Functions -> Create function ->
// paste this file) or the CLI (`supabase functions deploy chat`).
// Requires one secret: GEMINI_API_KEY (Project Settings -> Edge Functions
// -> Secrets). SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are already
// available to every Edge Function automatically -- nothing to set for
// those.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DAILY_LIMIT = 20;
const GEMINI_MODEL = "gemini-3.6-flash";
const MAX_MESSAGE_LEN = 500;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SYSTEM_PROMPT = `You are the customer-support chat assistant for June Digitals, a PS5 game rental service in the Philippines.

Only answer questions about: this business's game rentals, prices, availability, how Trophy vs Non-Trophy access works, how swapping games works, GCash payment, tracking codes, and rental rules. Friendly greetings/small talk are fine too.

You cannot look up a specific customer's rentals, payments or tracking code -- you have no access to their account. When someone asks about THEIR rental ("where's my game", "how many days left", "did my payment go through", "I lost my code"), point them to the right place instead of guessing: their rentals are at https://ps5-rentals.vercel.app/account/track.html, and anything needing a human (a lost tracking code, a payment that hasn't been confirmed) goes to Messenger.

If asked about anything unrelated to June Digitals' rental service (general trivia, coding help, other businesses, etc.), politely decline and steer back, e.g. "I can only help with June Digitals game rentals -- ask me about availability, pricing, or how rentals work!"

Never invent game titles, prices, or availability -- only use the CATALOG DATA below, which is live and accurate right now. If a customer asks about a game not listed there, say it's not currently in the catalog.

Keep answers short (2-4 sentences), friendly, and reply in the same language the customer used (English or Tagalog/Taglish are both fine).

Whenever you mention a specific game from the catalog, link its title using the exact markdown link given for that game in CATALOG DATA below, e.g. "[Ghost of Yotei](https://ps5-rentals.vercel.app/?game=ghost-of-yotei) is available now." Never invent a link or change the URL.

FAQ:
- Trophy Slot: played on the customer's own PSN profile, trophies and saves stay theirs.
- Non-Trophy Slot: played on the rented game's own profile, same full game access either way.
- Weekly plan: 7 days. Monthly plan: 30 days. Both include free swaps; the exact number allowed is shown on the customer's own rentals page, so don't quote a number -- point them there.
- Swap cooldown: 24h after a completed swap.

HOW RENTING WORKS NOW (this changed -- do not describe the old Messenger-only flow):
1. Customer clicks Rent on a game, picks Weekly or Monthly, then Trophy or Non-Trophy.
2. A payment screen appears ON THE WEBSITE with the exact amount, the GCash number and name to send to, and a reference code like R-K7M2QP to put in the GCash message. The game slot is held for them for 30 minutes while they pay.
3. They tap "I've paid -- send screenshot", which opens Messenger. They send their GCash screenshot there.
4. Staff match the reference code to the payment, confirm it, and send the PS5 account login on Messenger.
Messenger is now only for two things: sending the payment screenshot, and receiving the account login (plus general questions like these).

TRACKING CODE:
- Every customer gets a tracking code like JD-K7M2QP. It appears on the payment screen and is saved to their device automatically -- they normally never type it.
- It's how they check their rentals and swap games at https://ps5-rentals.vercel.app/account/track.html with no account and no password. Signing up for a full account at https://ps5-rentals.vercel.app/account/ does the same thing, plus lets them set a display name and a profile picture.
- If they lost it (cleared their browser, new phone), staff can resend it on Messenger.

HOW SWAPPING WORKS NOW:
- Open My Rentals, tap the game, tap Swap, pick a new game, confirm. Only someone with a currently active rental can swap -- the option is unavailable otherwise.
- The request goes to staff for approval -- it is NOT instant. The page shows "Waiting for approval" until then, and the new game is held for them for 24 hours.
- Once approved the listing changes, the end date stays the same, and staff send the new login on Messenger. Swapping is free.

HOW PRE-RELEASE RESERVATIONS WORK (for any game marked PRE-RESERVE in CATALOG DATA):
- The game isn't out yet, so there's nothing "available" to rent -- customers reserve a place in line instead, through the exact same Rent flow and GCash payment as a normal rental (same price, no extra reservation fee).
- Multiple customers can queue for the same slot before release. Their tracking/account page shows their queue position (e.g. "#7") once reserved -- don't guess a number, point them there.
- There's nothing else to do after paying. Staff activate reservations in queue order once the game is actually released, then send the account login on Messenger.`;

const SITE_URL = "https://ps5-rentals.vercel.app";

function catalogText(games: any[]): string {
  return games.map((g) => {
    const link = `[${g.title}](${SITE_URL}/?game=${g.slug})`;
    if (g.status === "upcoming") {
      return `${link} (PRE-RESERVE, releases ${g.release_date}): Trophy slot ${g.trophy_reservation_status}, Non-Trophy slot ${g.nontrophy_reservation_status}. Weekly ₱${g.trophy_weekly}, Monthly ₱${g.trophy_monthly}.`;
    }
    return `${link}: Trophy ${g.trophy_available ? "AVAILABLE" : "FULL"} (Weekly ₱${g.trophy_weekly} / Monthly ₱${g.trophy_monthly}), Non-Trophy ${g.nontrophy_available ? "AVAILABLE" : "FULL"} (Weekly ₱${g.nontrophy_weekly} / Monthly ₱${g.nontrophy_monthly}).`;
  }).join("\n");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Guarantees every catalog title Gemini mentions becomes a link, regardless
// of whether it followed the "use this markdown link" instruction -- replaces
// the first bare or **bolded** mention of each title with its link.
function linkifyGames(reply: string, games: any[]): string {
  let out = reply;
  const byLengthDesc = [...games].sort((a, b) => b.title.length - a.title.length);
  for (const g of byLengthDesc) {
    if (!g.slug) continue;
    const linkTarget = `(${SITE_URL}/?game=${g.slug})`;
    if (out.includes(linkTarget)) continue; // Gemini already linked it correctly -- don't double-wrap.
    const pattern = new RegExp(`\\*{0,2}${escapeRegExp(g.title)}\\*{0,2}`, "i");
    if (pattern.test(out)) {
      out = out.replace(pattern, `[${g.title}](${SITE_URL}/?game=${g.slug})`);
    }
  }
  return out;
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
      "slug,title,status,release_date,trophy_available,trophy_weekly,trophy_monthly,trophy_reservation_status,nontrophy_available,nontrophy_weekly,nontrophy_monthly,nontrophy_reservation_status"
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
    const rawReply = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ||
      "Sorry, I couldn't process that -- please try again or message us on Messenger.";
    // Gemini doesn't reliably follow the "use this markdown link" instruction
    // on its own -- guarantee the link by rewriting any mention of a catalog
    // title (bolded with ** or plain) into a link ourselves.
    const reply = linkifyGames(rawReply, games || []);

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
