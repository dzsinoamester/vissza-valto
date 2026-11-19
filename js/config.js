// Supabase beállítások. Ezek az értékek szándékosan nyilvánosak
// (a védelmet az adatbázis jogosultsági szabályai, az RLS adják).
// SOHA ne írd ide a sb_secret_... kulcsot!
window.VISSZA_CONFIG = {
  SUPABASE_URL: 'https://kukzlgfsabhgvnqvqfvc.supabase.co',
  SUPABASE_KEY: 'sb_publishable_IeYj8NbSD5WPGeq_kYB9Hg_HbPi_1iH',

  // Web push: VAPID PUBLIKUS kulcs (a privát a Supabase function secretje,
  // lásd .secrets/vapid-private.txt – SOHA ne kerüljön a repóba).
  VAPID_PUBLIC: 'BNHL0gHWBvpB8wUgghGznuXCQTek56TvFi-pNpFuyud6st_SjG4hxUQIW075_rEOptxiiF5CQxSU3mohSkQg1X4'
};
