// Supabase beállítások. Ezek az értékek szándékosan nyilvánosak
// (a védelmet az adatbázis jogosultsági szabályai, az RLS adják).
// SOHA ne írd ide a sb_secret_... kulcsot!
window.VISSZA_CONFIG = {
  SUPABASE_URL: 'https://kukzlgfsabhgvnqvqfvc.supabase.co',
  SUPABASE_KEY: 'sb_publishable_IeYj8NbSD5WPGeq_kYB9Hg_HbPi_1iH',

  // Web push: ide kerül a VAPID PUBLIKUS kulcs (a privát a Supabase function secretje).
  // Amíg üres, a Beállításokban nem jelenik meg a push kapcsoló.
  // Generálás: npx web-push generate-vapid-keys
  VAPID_PUBLIC: ''
};
