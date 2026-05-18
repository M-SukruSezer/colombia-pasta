# ☕ Colombia Coffee — Pasta SKT Takip Sistemi

Donuk pastalar için SKT (Son Kullanma Tarihi) takip sistemi.

## Özellikler

- ❄️ Donuk depo → 🌡️ Çözünme (8 saat) → 🧁 Food dolabı → ✅ Satış akışı
- SKT'ye 2 gün kalan ürünler için otomatik öneri satış listesi
- Çoklu mağaza yönetimi (Super Admin / Mağaza Müdürü / Personel)
- Tüm hareketlerin geçmiş kaydı

## Kurulum

```bash
npm install
npm run dev
```

Uygulama `http://localhost:5173` adresinde açılır.

## Demo Kullanıcılar

| Kullanıcı | Şifre | Rol |
|---|---|---|
| superadmin | admin123 | Süper Admin |
| merkez | merkez123 | Mağaza Müdürü |
| duzce | duzce123 | Mağaza Müdürü |

## Deploy (Vercel)

1. GitHub'a yükle
2. [vercel.com](https://vercel.com) → Import → Deploy

## Teknolojiler

- React 18 + Vite
- Supabase (PostgreSQL)
