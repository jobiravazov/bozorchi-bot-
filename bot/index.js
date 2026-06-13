require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');

// ── Firebase ──
const serviceAccount = require('./serviceAccount.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_URL
});
const db = admin.database();

const bot = new Telegraf(process.env.BOT_TOKEN, { handlerTimeout: 90000 });

// ── DB yordamchilar ──
async function dbGet(path) {
  return Promise.race([
    db.ref(path).once('value'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('DB timeout')), 15000))
  ]);
}
async function dbSet(path, data) {
  return Promise.race([
    db.ref(path).set(data),
    new Promise((_, reject) => setTimeout(() => reject(new Error('DB timeout')), 15000))
  ]);
}
async function dbUpdate(path, data) {
  return Promise.race([
    db.ref(path).update(data),
    new Promise((_, reject) => setTimeout(() => reject(new Error('DB timeout')), 15000))
  ]);
}

async function getUserShops(userId) {
  const snap = await dbGet('shops');
  if (!snap.exists()) return [];
  return Object.values(snap.val()).filter(s => String(s.ownerId) === String(userId));
}

function mainMenu() {
  return Markup.keyboard([
    ['📦 Buyurtmalar'],
    ['🏪 Do\'konlarim', '🗂 Kabinet']
  ]).resize();
}

function cancelMenu() {
  return Markup.keyboard([['❌ Bekor qilish']]).resize();
}

// ── Holat tozalash ──
async function clearState(userId) {
  await dbSet(`states/${userId}`, { step: 'main' });
}

// ── /start ──
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  await clearState(userId);

  const snap = await dbGet(`sellers/${userId}`);
  if (snap.exists()) {
    const seller = snap.val();
    const name = seller.fullName || ctx.from.first_name || 'Foydalanuvchi';
    const shops = await getUserShops(userId);

    if (shops.length > 0) {
      const list = shops.map((s, i) => `${i + 1}. *${s.shopName}*`).join('\n');
      return ctx.reply(
        `👋 Xush kelibsiz, *${name}*!\n\n🏪 Do'konlaringiz:\n${list}`,
        { parse_mode: 'Markdown', ...mainMenu() }
      );
    }
    return ctx.reply(
      `👋 Salom, *${name}*!\n\nDo'kon ochish uchun /yangidokon buyrug'ini yuboring.`,
      { parse_mode: 'Markdown', ...mainMenu() }
    );
  }

  await dbSet(`states/${userId}`, { step: 'waiting_fullname' });
  return ctx.reply(
    `🎉 *Bozorchi*ga xush kelibsiz!\n\nBu yerda siz onlayn do'kon ochib, tovar yoki xizmat sotasiz.\n\n` +
    `Boshlash uchun ismingiz va familiyangizni kiriting:\n_Masalan: Jasur Toshmatov_`,
    { parse_mode: 'Markdown' }
  );
});

// ── /yangidokon ──
bot.command('yangidokon', async (ctx) => {
  const userId = ctx.from.id;
  const snap = await dbGet(`sellers/${userId}`);
  if (!snap.exists()) {
    return ctx.reply('❌ Avval /start orqali ro\'yxatdan o\'ting.');
  }
  await dbSet(`states/${userId}`, { step: 'waiting_shop_name' });
  return ctx.reply(
    `🏪 Yangi do'kon ochish!\n\nDo'kon nomini kiriting:\n_Masalan: Malika Qandolati_`,
    { parse_mode: 'Markdown', ...cancelMenu() }
  );
});

// ── /dokon (eski) — yangi buyruqga yo'naltirish ──
bot.command('dokon', async (ctx) => {
  return ctx.reply(
    `ℹ️ Yangi do'kon ochish uchun /yangidokon buyrug'ini yuboring.`,
    mainMenu()
  );
});

// ── Matn xabarlari ──
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;

  // Bekor qilish — istalgan bosqichda
  if (text === '❌ Bekor qilish') {
    await clearState(userId);
    return ctx.reply('↩️ Bekor qilindi.', mainMenu());
  }

  const stateSnap = await dbGet(`states/${userId}`);
  const state = stateSnap.val();

  // Agar holat yo'q yoki main — menyu tugmalarini tekshir
  if (!state || state.step === 'main' || state.step === 'registered') {

    // Do'konlarim
    if (text === '🏪 Do\'konlarim') {
      const shops = await getUserShops(userId);
      if (!shops.length) {
        return ctx.reply('📭 Hali do\'kon ochmadingiz.\n\n/yangidokon buyrug\'ini yuboring.', mainMenu());
      }
      const list = shops.map((s, i) =>
        `${i + 1}. *${s.shopName}*\n` +
        `   📌 ${s.shopType === 'tovar' ? 'Tovar sotish' : 'Xizmat ko\'rsatish'}\n` +
        `   🔗 https://bozorchi-uz-edc3e.web.app?shop=${s.slug}`
      ).join('\n\n');
      return ctx.reply(
        `🏪 *Do'konlaringiz:*\n\n${list}\n\n➕ Yangi do'kon: /yangidokon`,
        { parse_mode: 'Markdown', ...mainMenu() }
      );
    }

    // Buyurtmalar
    if (text === '📦 Buyurtmalar') {
      const shops = await getUserShops(userId);
      if (!shops.length) {
        return ctx.reply('📭 Hali do\'kon yo\'q. /yangidokon buyrug\'ini yuboring.', mainMenu());
      }
      let hasOrders = false;
      for (const shop of shops) {
        const snap = await db.ref(`buyurtmalar/${shop.shopId}`)
          .orderByChild('status').equalTo('new').once('value');
        const buyurtmalar = snap.val();
        if (!buyurtmalar) continue;
        hasOrders = true;
        for (const b of Object.values(buyurtmalar)) {
          const items = b.items
            ? Object.values(b.items).map(i => `• ${i.name} x${i.qty} — ${formatPrice(i.price * i.qty)} so'm`).join('\n')
            : `• ${b.taklifName || 'Noma\'lum'}`;
          await ctx.reply(
            `🆕 *Yangi buyurtma #${b.id}*\n` +
            `🏪 Do'kon: *${shop.shopName}*\n\n` +
            `👤 Mijoz: ${b.customerName || 'Noma\'lum'}\n` +
            `📱 Tel: ${b.phone}\n` +
            `📦 Buyurtma:\n${items}\n` +
            `💰 Jami: ${formatPrice(b.total)} so'm\n` +
            `🚗 Yetkazish: ${b.delivery === 'delivery' ? `📍 ${b.address}` : 'Olib ketadi'}\n` +
            `💬 Izoh: ${b.note || 'Yo\'q'}`,
            {
              parse_mode: 'Markdown',
              ...Markup.inlineKeyboard([[
                Markup.button.callback('✅ Qabul', `accept_${shop.shopId}_${b.id}`),
                Markup.button.callback('❌ Rad', `reject_${shop.shopId}_${b.id}`)
              ]])
            }
          );
        }
      }
      if (!hasOrders) return ctx.reply('📭 Yangi buyurtma yo\'q.', mainMenu());
      return;
    }

    // Kabinet
    if (text === '🗂 Kabinet') {
      return ctx.reply(
        `🗂 *Kabinet*\n\nDo'konni boshqarish, takliflar va statistika:\n\n` +
        `👉 https://bozorchi-uz-edc3e.web.app/kabinet.html?id=${userId}`,
        { parse_mode: 'Markdown', ...mainMenu() }
      );
    }

    return; // Noma'lum matn — e'tiborsiz
  }

  // ── 1. Ism familiya ──
  if (state.step === 'waiting_fullname') {
    const trimmed = text.trim();
    if (trimmed.length < 3 || trimmed.length > 60) {
      return ctx.reply('❌ Ism familiya 3-60 ta belgidan iborat bo\'lishi kerak. Qaytadan kiriting:');
    }
    await dbSet(`sellers/${userId}`, {
      telegramId: userId,
      username: ctx.from.username || null,
      fullName: trimmed,
      createdAt: Date.now(),
      plan: 'free'
    });
    await dbSet(`states/${userId}`, { step: 'waiting_phone' });
    return ctx.reply(
      `✅ Rahmat, *${trimmed}*!\n\nEndi telefon raqamingizni kiriting:\n_Masalan: 901234567_`,
      { parse_mode: 'Markdown', ...cancelMenu() }
    );
  }

  // ── 2. Telefon raqam ──
  if (state.step === 'waiting_phone') {
    const phone = text.replace(/\D/g, '');
    if (phone.length < 9 || phone.length > 13) {
      return ctx.reply('❌ Telefon raqam noto\'g\'ri. Qaytadan kiriting:\n_Masalan: 901234567_', { parse_mode: 'Markdown' });
    }
    await dbUpdate(`sellers/${userId}`, { phone });
    await dbSet(`states/${userId}`, { step: 'registered' });
    return ctx.reply(
      `✅ Ro'yxatdan o'tdingiz!\n\nEndi do'kon ochish uchun /yangidokon buyrug'ini yuboring.`,
      { parse_mode: 'Markdown', ...mainMenu() }
    );
  }

  // ── 3. Do'kon nomi ──
  if (state.step === 'waiting_shop_name') {
    const trimmed = text.trim();
    if (trimmed.length < 2 || trimmed.length > 50) {
      return ctx.reply('❌ Do\'kon nomi 2-50 ta belgidan iborat bo\'lishi kerak. Qaytadan kiriting:');
    }
    await dbSet(`states/${userId}`, { step: 'waiting_shop_type', pendingShopName: trimmed });
    return ctx.reply(
      `✅ Do'kon nomi: *${trimmed}*\n\nDo'kon turini tanlang:`,
      {
        parse_mode: 'Markdown',
        ...Markup.keyboard([
          ['🛍 Tovar sotish'],
          ['🤝 Xizmat ko\'rsatish'],
          ['❌ Bekor qilish']
        ]).resize()
      }
    );
  }

  // ── 4. Do'kon turi ──
  if (state.step === 'waiting_shop_type') {
    let shopType = null;
    if (text === '🛍 Tovar sotish') shopType = 'tovar';
    else if (text === '🤝 Xizmat ko\'rsatish') shopType = 'xizmat';
    else {
      return ctx.reply(
        'Iltimos, quyidagi tugmalardan birini tanlang:',
        Markup.keyboard([['🛍 Tovar sotish'], ['🤝 Xizmat ko\'rsatish'], ['❌ Bekor qilish']]).resize()
      );
    }

    const shopName = state.pendingShopName;
    const slug = transliterate(shopName);

    // Slug tekshirish
    const existingSnap = await dbGet('shops');
    if (existingSnap.exists()) {
      const exists = Object.values(existingSnap.val()).find(s => s.slug === slug);
      if (exists) {
        await dbSet(`states/${userId}`, { step: 'waiting_shop_name' });
        return ctx.reply(
          `❌ *${shopName}* nomi allaqachon band.\n\nBoshqa nom kiriting:`,
          { parse_mode: 'Markdown', ...cancelMenu() }
        );
      }
    }

    const shopId = db.ref('shops').push().key;
    await dbSet(`shops/${shopId}`, {
      shopId, ownerId: userId,
      shopName, slug, shopType,
      isActive: true, createdAt: Date.now()
    });
    await clearState(userId);

    return ctx.reply(
      `🎉 Do'kon ochildi!\n\n` +
      `🏪 *${shopName}*\n` +
      `📌 Tur: ${shopType === 'tovar' ? '🛍 Tovar sotish' : '🤝 Xizmat ko\'rsatish'}\n` +
      `🔗 Havola: https://bozorchi-uz-edc3e.web.app?shop=${slug}\n\n` +
      `📊 Kabinet: https://bozorchi-uz-edc3e.web.app/kabinet.html?id=${userId}`,
      { parse_mode: 'Markdown', ...mainMenu() }
    );
  }
});

// ── Inline tugmalar ──
bot.action(/accept_(.+?)_(.+)/, async (ctx) => {
  const shopId = ctx.match[1];
  const buyurtmaId = ctx.match[2];
  await dbUpdate(`buyurtmalar/${shopId}/${buyurtmaId}`, { status: 'accepted', acceptedAt: Date.now() });
  await ctx.answerCbQuery('✅ Qabul qilindi!');
  await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n✅ *QABUL QILINDI*', { parse_mode: 'Markdown' });
});

bot.action(/reject_(.+?)_(.+)/, async (ctx) => {
  const shopId = ctx.match[1];
  const buyurtmaId = ctx.match[2];
  await dbUpdate(`buyurtmalar/${shopId}/${buyurtmaId}`, { status: 'rejected', rejectedAt: Date.now() });
  await ctx.answerCbQuery('❌ Rad etildi');
  await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n❌ *RAD ETILDI*', { parse_mode: 'Markdown' });
});

// ── Yordamchi funksiyalar ──
function formatPrice(n) {
  return Number(n).toLocaleString('uz-UZ');
}

function transliterate(text) {
  const map = {
    'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo','ж':'j','з':'z',
    'и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r',
    'с':'s','т':'t','у':'u','ф':'f','х':'x','ц':'ts','ч':'ch','ш':'sh','щ':'sh',
    'ъ':'','ы':'i','ь':'','э':'e','ю':'yu','я':'ya',
    'a':'a','b':'b','d':'d','e':'e','f':'f','g':'g','h':'h','i':'i','j':'j',
    'k':'k','l':'l','m':'m','n':'n','o':'o','p':'p','q':'q','r':'r','s':'s',
    't':'t','u':'u','v':'v','w':'w','x':'x','y':'y','z':'z',
    "'":'','`':''
  };
  return text.toLowerCase()
    .split('')
    .map(c => map[c] !== undefined ? map[c] : c)
    .join('')
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

bot.launch().then(() => {
  console.log('🚀 Bozorchi bot ishga tushdi!');
}).catch(err => {
  console.error('❌ Bot xatosi:', err);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));