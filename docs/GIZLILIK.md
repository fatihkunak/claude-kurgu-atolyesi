# Gizlilik (yüz bulanıklığı)

Panelin **Gizlilik** aşaması, yoldan geçenlerin yüzlerini teslim videoda bulanıklaştırır. Arkada `scripts/85-privacy.mjs` ve `scripts/py/*` çalışır; panel bunların arayüzüdür.

## Kurulum (bir kez)

Yüz algılama sistem Python'una dokunmayan ayrı bir venv kullanır (OpenCV + YuNet modeli):

```powershell
node scripts/85-privacy.mjs setup
```

Panel adımları çalıştırır ama bu kurulumu kendisi yapmaz; yapılmadıysa adım "Önce: node scripts/85-privacy.mjs setup" hatasıyla düşer.

## Akış

1. **Tara**: her karede yüz arar (15 örnek/sn). **Uzun sürer**: 4K'da yaklaşık 6 dk'lık video için ~35 dk.
2. **İzleri çıkar**: algıları zaman içinde izlere bağlar (`F001`, `F002`…) ve her iz için bir yüz kırpması üretir.
3. **Yüz izleri**: kartlara bak. Yanlış bulunanları (heykel, duvar resmi, maske, afiş) kapat; **sarı çerçeve = bulanıklaştırılacak**, kapatılan kart soluk görünür. En küçük yüz boyutu (px) alanından çok küçük (tanınamaz) yüzler elenir.
4. **Elle kutular** (plaka, tabela, ekran): bir süre seç, **Kareyi getir**, karenin üzerinde sürükleyerek kutu çiz; süre varsayılan 2 sn, listeden değiştirilir. Şekil dikdörtgen ya da elips.
5. **Maske**: onaylanan izler ve elle kutulardan `work/privacy/mask.mkv` üretilir.
6. **Birleştirmede uygula**: açıkken sonraki `composite` maskeyi uygular. **Yeniden render gerekir** (4K, 5 dk'lık videoda ~50 dk ölçüldü).

Bulanıklık, kaynağın 1/32 çözünürlüğe pikselleştirilmiş hâlini yumuşatılmış (feathered) maskeyle karıştırarak yapılır; maske dışındaki piksellere dokunulmaz.

## Kalite kontrol

`privacy: true` iken `scripts/80-qc.mjs`, "resim değişmedi" (PSNR) karşılaştırmasında **referansı da aynı maskeden geçirir**; böylece kontrol "bulanıklık dışında her şey dokunulmamış mı" sorusunu yanıtlar (maske uygulanmadan 37,21 dB'ye düşüp sahte hata veriyordu, düzeltmeyle 41,86 dB).

## Dosyalar

| Dosya | İçerik |
|---|---|
| `work/privacy/faces.raw.json` | Ham yüz algıları |
| `work/privacy/proposals.json` | Yüz izleri (kimlik, süre, kutular) |
| `work/privacy/approved.json` | Eşikler, `skipIds` (kapatılan izler), `exclude` (bulanıklaştırılmayacak bölgeler) |
| `work/privacy/manual.json` | Elle kutular `{start, end, x, y, w, h, shape}` (kaynak piksel) |
| `work/privacy/mask.mkv` | Maske videosu (beyaz = bulanık) |
| `work/project.json → privacy` | `true` ise birleştirmede uygulanır |

## Sınırlar

- **Plaka algılayıcı yok**: plakaları elle kutuyla ekle.
- Heykel/duvar resmi gibi yüz benzeri şeyler de algılanır; kartları gözle gözden geçirmek gerekir.
- İz kapatılınca o izin kutu birleşimi (+%15 pay) ve süresi dışlanır; iz hareket ediyorsa bu geniş bir alan olabilir.
- Algılama kaçırabilir (yan profil, çok küçük, hızlı dönen kamera): bulanıklık **tam bir güvence değildir**, yayından önce videoya bak.
- Render ya da başka bir iş çalışırken Tara/İzler/Maske başlatılamaz (CPU/RAM).
- Panelin kart/elle kutu yazımı ve Birleştir akışı gerçek projede elle denenmedi; sunucu tarafı birim testlidir.
