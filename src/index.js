// ==================== CONFIG ====================
const WORDPRESS_URL = "https://wordpress.herbcares.store";
const WOOCOMMERCE_URL = "https://wordpress.herbcares.store"; // আপনার WooCommerce site
const DUPLICATE_WINDOW_HOURS = 72;
const TEST_NUMBERS = ["01912494453", "01958488957", "01722866990", "01900000000"];
const DEFAULT_PRICE = 700;
const DEFAULT_PHONE = "01958488957";
const DEFAULT_PRODUCT_ID = 301;

// ⚠️ এই দুটো ভ্যালু functions.php এর HERBCARES_SHARED_SECRET এবং
// Apps Script Web App URL এর সাথে হুবহু মিলতে হবে।
const SHARED_SECRET = "e5c96100729187f7fddc4a8029df9be28810986eac5c5969";
const GOOGLE_SHEET_URL = "https://script.google.com/macros/s/AKfycbz_rIyjRsb5aWCCpNlGd-9tHXvXe75dIlJ0SM3gPPTr04pHDg0KR93U719mDYMLl6tk/exec";

// ⚠️ টেলিগ্রাম বট কনফিগারেশন (আপনার আসল টোকেন ও চ্যাট আইডি দিন)
const TELEGRAM_BOT_TOKEN = "8753011731:AAFwnQR4Ykd96d5wpN_0GBN0oRtkCpWuxrs"; 
const TELEGRAM_CHAT_ID = "-5165030636"; 

// ⚠️ আপনার n8n ওয়েবহুকের দুটি URL এখানে দিন (Server-Side Tracking এর জন্য)
const N8N_WEBHOOK_URL_1 = "https://n8n.herbcares.store/webhook/fb-purchase-capi"; 
const N8N_WEBHOOK_URL_2 = "https://n8n.herbcares.store/webhook/order-status-update"; 

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    try {
      if (url.pathname === "/api/get-config" && request.method === "GET") {
        return await handleGetConfig(env);
      }

      if (url.pathname === "/api/place-order" && request.method === "POST") {
        return await handlePlaceOrder(request, env, ctx);
      }
    } catch (err) {
      return jsonResponse({ success: false, message: "Server error", error: err.message }, 500);
    }

    // বাকি সব static files (HTML, images) হিসেবে serve হবে
    return env.ASSETS.fetch(request);
  },
};

// ==================== GET CONFIG ====================
async function handleGetConfig(env) {
  try {
    const res = await fetchWithTimeout(
      `${WORDPRESS_URL}/wp-json/herbcares/v1/config?product_id=${DEFAULT_PRODUCT_ID}`,
      { cf: { cacheTtl: 60, cacheEverything: true } }, // ৬০ সেকেন্ড cache
      3000 // ৩ সেকেন্ডের বেশি দেরি হলে fallback (default price)
    );

    if (!res.ok) throw new Error("WordPress config fetch failed");

    const data = await res.json();

    return jsonResponse({
      success: true,
      price: data.price || DEFAULT_PRICE,
      phone: data.phone || DEFAULT_PHONE,
      product_id: data.product_id || DEFAULT_PRODUCT_ID,
    });
  } catch (err) {
    // Fallback to default যদি WordPress থেকে আনতে fail করে
    return jsonResponse({
      success: true,
      price: DEFAULT_PRICE,
      phone: DEFAULT_PHONE,
      product_id: DEFAULT_PRODUCT_ID,
      fallback: true,
    });
  }
}

// ==================== PLACE ORDER ====================
async function handlePlaceOrder(request, env, ctx) {
  const body = await request.json();
  const { name, phone: rawPhone, address } = body;
  // CAPI-র জন্য Facebook cookies (browser থেকে আসে)
  const fbp = body.fbp || "";
  const fbc = body.fbc || "";

  // ---- CAPI-র জন্য client meta (browser পাঠানো fields → fallback headers) ----
  const clientIp = body.client_ip_address || request.headers.get("CF-Connecting-IP") || request.headers.get("x-forwarded-for") || "";
  const userAgent = body.client_user_agent || request.headers.get("user-agent") || "";
  const sourceUrl = body.event_source_url || request.headers.get("referer") || "";

  // ---- Validation ----
  if (!name || !rawPhone || !address) {
    return jsonResponse({ success: false, message: "নাম, মোবাইল নম্বর ও ঠিকানা আবশ্যক" }, 400);
  }

  const phone = normalizePhone(rawPhone);
  if (!isValidBangladeshiPhone(phone)) {
    return jsonResponse({ success: false, message: "সঠিক ১১ ডিজিটের মোবাইল নম্বর দিন" }, 400);
  }

  const isTestNumber = TEST_NUMBERS.includes(phone);

  // ---- Duplicate Check (test number বাদে) ----
  if (!isTestNumber) {
    const existing = await env.ORDER_KV.get(`order:${phone}`);
    if (existing) {
      const lastOrderTime = parseInt(existing, 10);
      const hoursPassed = (Date.now() - lastOrderTime) / (1000 * 60 * 60);
      if (hoursPassed < DUPLICATE_WINDOW_HOURS) {
        return jsonResponse(
          {
            success: false,
            message: "আপনার অর্ডার ইতিমধ্যে গ্রহণ করা হয়েছে। ডেলিভারির জন্য অপেক্ষা করুন।",
          },
          409
        );
      }
    }
  }

  // ---- Get current price/product from WordPress (fallback safe) ----
  const config = await getConfigInternal(env);

  // ---- Build order payload (WordPress এর নতুন direct endpoint এর জন্য) ----
  const orderData = {
    name,
    phone,
    address,
    product_id: config.product_id,
    price: config.price,
    is_test: isTestNumber,
    // ---- CAPI fields (WordPress order meta-তে store হবে, confirmation-এ কাজে লাগবে) ----
    fbp: fbp,
    fbc: fbc,
    client_ip_address: clientIp,
    client_user_agent: userAgent,
    event_source_url: sourceUrl,
  };

  // ---- Send to WordPress (shared-secret auth, WooCommerce key/secret লাগবে না) ----
  let wooResult = null;
  let wooSuccess = false;
  try {
    const wcRes = await fetch(`${WOOCOMMERCE_URL}/wp-json/herbcares/v1/place-order`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-herbcares-token": SHARED_SECRET,
      },
      body: JSON.stringify(orderData),
    });
    wooResult = await wcRes.json();
    wooSuccess = wcRes.ok && wooResult.success;
    if (!wooSuccess) {
      console.log("WooCommerce rejected order:", wcRes.status, JSON.stringify(wooResult));
    }
  } catch (err) {
    wooResult = { error: err.message };
    console.log("WooCommerce send failed:", err.message);
  }

  // WP place-order এখন আসল product price ফেরত দেয় — সব জায়গায় সেটাই ব্যবহার হবে।
  // pixel/CAPI-তে সবসময় WooCommerce-এর real price যাবে, fallback নয়।
  const actualPrice = wooSuccess && wooResult.price ? Number(wooResult.price) : config.price;

  // ---- ব্যাকআপ পেলোড তৈরি (Google Sheet এবং Telegram এর জন্য) ----
  const backupPayload = {
    order_id: wooSuccess ? wooResult.order_id : "",
    name,
    phone,
    address,
    product: "জিনসেং ক্যাপসুল (Full Course)",
    price: actualPrice,
    status: wooSuccess ? "WooCommerce Success" : "WooCommerce Failed - Backup Only",
    source: isTestNumber ? "Test" : "Live",
  };

  // ---- Send to Google Sheet (backup) ----
  ctx.waitUntil(sendToGoogleSheet(backupPayload));
  
  // ---- Send to Telegram (backup/notification) ----
  ctx.waitUntil(sendToTelegram(backupPayload));

  // ---- Save duplicate-check marker (test number বাদে) ----
  if (!isTestNumber) {
    await env.ORDER_KV.put(`order:${phone}`, Date.now().toString(), {
      expirationTtl: DUPLICATE_WINDOW_HOURS * 60 * 60, // সেকেন্ডে
    });
  }

  // ---- Response to frontend ----
  if (wooSuccess) {
    
    // ====== N8N কে ট্রিগার করার জন্য নতুন কোড (Server-Side Pixel) ======
    const n8nPayload = {
      event_name: "Purchase",
      event_id: wooResult.order_id.toString(), // Deduplication এর জন্য দরকার
      order_id: wooResult.order_id,
      name: name,
      phone: phone, // n8n এর Crypto নোড এটি 880 ফরম্যাটে নিয়ে SHA-256 হ্যাশ করবে
      address: address, // CAPI: location match
      price: actualPrice,
      currency: "BDT",
      source: isTestNumber ? "Test" : "Live",
      // ---- CAPI upgrade: browser cookies + client meta ----
      fbp: fbp,                 // Facebook browser cookie (dedup + match)
      fbc: fbc,                 // Facebook click cookie (dedup + match)
      client_ip_address: clientIp,   // match quality বৃদ্ধি
      client_user_agent: userAgent,  // match quality বৃদ্ধি
      event_source_url: sourceUrl,   // কোন পেজ থেকে অর্ডার
      action_source: "website",
      content_id: "ginseng-capsule",
    };
    
    // দুটি ওয়েবহুকেই ডাটা পাঠানো হচ্ছে
    ctx.waitUntil(sendToN8n(N8N_WEBHOOK_URL_1, n8nPayload)); 
    ctx.waitUntil(sendToN8n(N8N_WEBHOOK_URL_2, n8nPayload)); 
    // =========================================================

    return jsonResponse({
      success: true,
      order_id: wooResult.order_id,
      message: "অর্ডার সফল হয়েছে",
      price: actualPrice,
      product_name: "জিনসেং ক্যাপসুল (Full Course)",
    });
  } else {
    // WooCommerce fail করলেও Sheet এ গিয়েছে, তাই customer কে soft error দেখাবো
    return jsonResponse(
      {
        success: false,
        message: "অর্ডারটি গ্রহণ করা হয়েছে, শীঘ্রই যোগাযোগ করা হবে।", 
        backup: true,
      },
      200
    );
  }
}

// ==================== HELPERS ====================

// ৩ সেকেন্ড timeout — WordPress দেরি করলে fallback price ব্যবহার হবে
// (API slow হলে display-এ default ৭০০ দেখাবে, কিন্তু pixel-এ সবসময় real price যাবে)
async function fetchWithTimeout(url, opts = {}, ms = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getConfigInternal(env) {
  try {
    const res = await fetchWithTimeout(`${WORDPRESS_URL}/wp-json/herbcares/v1/config?product_id=${DEFAULT_PRODUCT_ID}`, {}, 3000);
    if (!res.ok) throw new Error("fail");
    const data = await res.json();
    return {
      price: data.price || DEFAULT_PRICE,
      product_id: data.product_id || DEFAULT_PRODUCT_ID,
    };
  } catch {
    return { price: DEFAULT_PRICE, product_id: DEFAULT_PRODUCT_ID };
  }
}

async function sendToGoogleSheet(payload) {
  try {
    await fetch(GOOGLE_SHEET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.log("Sheet send failed:", err.message);
  }
}

// টেলিগ্রাম ফাংশন
async function sendToTelegram(payload) {
  try {
    const escapeHtml = (text) => {
      if (!text) return "N/A";
      return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    };

    const message = `🛒 <b>New Order Received!</b>\n\n` +
      `🆔 Order ID: <b>#${escapeHtml(payload.order_id)}</b>\n` +
      `👤 Name: ${escapeHtml(payload.name)}\n` +
      `📞 Phone: <code>${escapeHtml(payload.phone)}</code>\n` +
      `📍 Address: ${escapeHtml(payload.address)}\n` +
      `📦 Product: ${escapeHtml(payload.product)}\n` +
      `💰 Price: <b>${payload.price} Tk</b>\n` +
      `📊 Status: ${escapeHtml(payload.status)} (${escapeHtml(payload.source)})`;

    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "HTML",
        disable_web_page_preview: true
      })
    });
  } catch (err) {
    console.log("Telegram send failed:", err.message);
  }
}

// n8n ওয়েবহুকে ডাটা পাঠানোর ফাংশন (দুটি ওয়েবহুকের জন্য)
async function sendToN8n(url, payload) {
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.log("n8n trigger failed:", err.message);
  }
}

function normalizePhone(raw) {
  let cleaned = raw.replace(/[\s\-\+\(\)]/g, "");
  if (cleaned.startsWith("880")) {
    cleaned = "0" + cleaned.slice(3);
  }
  return cleaned;
}

function isValidBangladeshiPhone(phone) {
  return /^01[3-9]\d{8}$/.test(phone);
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}