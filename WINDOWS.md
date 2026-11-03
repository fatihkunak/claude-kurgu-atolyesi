# Windows notları (bu kopya macOS şablonundan uyarlandı)

Kaynak şablon: `onuryildriim/claude-kurgu-atolyesi` (MIT). Bu klasör onun Windows uyarlamasıdır.

## Ne değişti
| Dosya | Değişiklik |
|---|---|
| `scripts/lib/platform.mjs` (yeni) | `which`/`where`, `listDir`, `diskFree`, `draftEncoder`, `tileSheet`, `whisperCli`, `aacEncoder` yardımcıları |
| `scripts/00-probe.mjs` | `which`, `ls`, `df` yerine yardımcılar; `hevc_nvenc` algılanır |
| `scripts/70-composite.mjs` | `--draft` kodlayıcısı: macOS VideoToolbox, aksi halde NVENC, o da yoksa libx265 ultrafast. Master (libx265) aynı |
| `scripts/65`, `66`, `80` | `-pattern_type glob` (Windows ffmpeg'de yok) yerine `tileSheet` (concat + tile) |
| `scripts/20-transcribe.mjs` | `whisperCli()` ile `whisper-cli` yolu bulunur |
| `scripts/75-audio.mjs` | `aac_at` (macOS AudioToolbox) yerine `aacEncoder()`: macOS dışında yerleşik `aac` |
| `scripts/run-master-detached.mjs` (yeni) | `nohup` zincirinin Node karşılığı: `npm run master:detached` |

## Windows'ta kullanım
- Uzun işler için `nohup scripts/run-master-detached.sh` yerine **`npm run master:detached`**. İzleme: `work/logs/chain.log`, `render-gfx.log`, `composite.log`.
- Takip için `! tail -f` yerine PowerShell: `Get-Content work\logs\chain.log -Wait -Tail 20`.
- Taslak: `npm run composite:draft` NVENC kullanır (yalnızca inceleme içindir, teslim edilmez).
- Pipeline sırası: `probe → luts → proxy → transcribe → ...` (`proxy` LUT'lardan sonra gelir).

## whisper.cpp (kuruldu)
- İkili: `C:\Users\Fatih\_tools\whisper-cpp-1.9.2\bin\Release\whisper-cli.exe` (ggml-org v1.9.2, `whisper-cublas-12.4.0-bin-x64.zip`, CUDA, RTX 3050 Ti'yi görüyor). Son sürüm v1.9.5'te hazır Windows ikilisi yok, bu yüzden v1.9.2.
- Model: `C:\Users\Fatih\Models\whisper\ggml-large-v3-turbo.bin` (1.624.555.275 bayt, boyut doğrulandı).
- `whisperCli()`: önce `$WHISPER_CLI`, sonra PATH, sonra yukarıdaki klasör. PATH'e ekleme gerekmez.

## Doğrulananlar (2026-10-30, uçtan uca)
Sentetik girdi: 30 sn, 1080p HLG, ema-lightning ile seslendirilmiş Türkçe konuşma. Tüm hat çalıştı:
`probe → luts → proxy → transcribe → review → plan:check → render:gfx → composite → qc → audio → qc:mix`
- Deşifre: 30 sn konuşma CUDA'da ~4,5 sn; 83 kelimenin 82'si doğru (fark: "beş" yerine "5" rakamı).
- Remotion render: 3 segment ~2,5 dk (Chrome Headless Shell ilk çalışmada otomatik indi). `npm run master:detached` zinciri hatasız bitti.
- `qc`: 21 kontrol, `qc:mix`: 24 kontrol, hepsi geçti. Kontak sayfaları (`tileSheet`) gerçek veride 2 sayfa üretti.
- `npm install`, `tsc --noEmit`, `eslint src` temiz.
- Test verisi `projects/_windows-selftest-2026-10-30/` altında arşivli (çıktı: `out/final-hlg.mov`).

**Düzeltme:** yukarıdaki testte grafikler aslında bozuktu. Segmentler hep 3840×2160 üretilir, 1080p kaynakta ölçeklenmeden bindirildiği için yalnız sol üst çeyreği görünüyordu. QC bunu yakalamaz (21 + 24 kontrolün hepsi yine geçti), kontak sayfasına gözle bakmak şart. `70-composite.mjs` artık segmentleri kaynak boyutuna ölçekler, 16:9 olmayan kaynakta durur.

## Doğrulananlar (2026-10-30, ikinci tur)
- Markalı tam hat, 1080p sentetik kaynak: `qc` 21, `qc:mix` 24 geçti; panolar, Türkçe karakterler ve fontlar kontak sayfasında doğru. Arşiv: `projects/_marka-selftest-2026-10-30/`.
- Gerçek Osmo Pocket 3 klibi (dikey 1728x3072, 50 fps, 10 bit, 170 sn, tek konuşmacı, canlı ortam): `probe` geçti, deşifre CUDA'da ~12 sn. Metin okunaklı, ses dinlenerek karşılaştırılmadı. Arşiv: `projects/_osmo-gercek-test-2026-10-30/`.
- Grafik render hızı: 4K segmentte ~3,5 kare/sn (638 kare, 3 dk). 10 dk'lık 30 fps videoda %40 grafik için tahmin ~35 dk; 50 fps'te daha uzun.
- `probe` uyarıları: kalkık siyah (HLG dışı, 5 noktada en düşük Y > 120 / 10 bit) ve dikey kaynak. Normal Osmo klibinde siyah uyarısı çıkmadı, yapay soluk kopyada çıktı.

## Doğrulanmayanlar / açık işler
- Gerçek video ile ilk tam kurgu: `osmo-test-2026-10-27` (4K yatay, 50 fps, 16 sn, 2026-10-31). Grafik ~5,4 kare/sn, 4K composite 4 dk 46 sn; `qc` ve `qc:mix` geçti. Uzun gerçek videoda denenmedi.
- `80-qc.mjs` kısa aralıkları da ölçer (osmo klibinde 3 pencere, en düşük 49,5 dB). Hiç pencere yoksa `ATLANDI` yazar, o üç kontrol ölçülmemiştir.
- Zincirin ilk denemesinde `60-render-segments` son segmentte hata yazmadan düştü, tek başına yeniden çalıştırınca geçti; neden bulunamadı. `chain.log` artık çıkış kodu ve sinyali yazar.
- `66-cut-check.mjs` Windows yol hatası düzeltildi, gerçek klipte çalıştı.
- `05-new-project.mjs`: kilitli dosyada 5 sn yeniden dener, yine olmazsa yaptığı tüm taşımaları geri alır (kilitli dosyayla denendi). `cp -c` yalnız macOS'ta.
- D-Log M uyarısı doygunlukla çalışır (SATAVG < 50): gerçek D-Log M drone klipleri 29–47, Normal Osmo 57–88 ölçüldü. Örnek drone'dan, Osmo Pocket D-Log'u ölçülmedi. Yalnız uyarıdır; kare kontrolü (`MARKA.md` §7, §9) geçerli. DJI dosyası Normal modda da bt709 etiketli.
- `npm run lut` LUT'u uygulayıp `public/derived/base.mov` üretir, `project.json → source` onu gösterir; `main.mov` değişmez. Drone klibi + gerçek konuşma sesiyle panelden tam render edildi: QC 21 ve 24 geçti (2026-10-31).
- LUT makinede yalnız CapCut klasöründe: `%LOCALAPPDATA%\CapCut\User Data\Resources\Lut\DJI D-Log M to Rec.709\DJI D-Log M to Rec.709.cube` (33³, 35.937 satır). Bulunan tek kullanıcı LUT'u bu; `library/luts/dji-dlogm-to-709.cube` varsa o önceliklidir.
- Dikey kaynak desteklenmiyor: grafik katmanı 16:9, proxy 1920x1080'e sıkıştırır.
- Ham çekimde tekrar eden tekrar alımlar var; atölye kesilmiş video bekler, kesim kurgu programında yapılır.
- `composite:draft` NVENC yolu gerçek zincirde denenmedi, yalnız sentetik kodlamada. Etiketsiz karelerde NVENC HLG etiketini yazmıyor; gerçek kaynak etiketli olduğundan sorun beklenmez.
- `kinetic` satırında `accent` tek kelimeyle eşleşir (`["5"]`, `["kilometre"]`); `["5 kilometre"]` boyamaz.

## Masaüstü uygulaması
`studio/desktop` (Tauri 2): `npx @tauri-apps/cli@2 build` → `src-tauri/target/release/bundle/nsis/*setup.exe`. Exe yalnız pencere ve başlatıcıdır; atölye (node_modules, ffmpeg, whisper, Claude Code) bu makinede kalır, başka PC'ye taşınmaz. Klasör: `KURGU_ROOT`, sonra `%LOCALAPPDATA%\KurguAtolyesi\root.txt`, sonra `~\kurgu-atolyesi`. Sunucu günlüğü: `%LOCALAPPDATA%\KurguAtolyesi\server.log`. `studio/` değişince exe'yi yeniden derlemek gerekmez, uygulamayı kapatıp açmak yeter.

## Panel testleri ve çevrimdışı
- `npm run test:studio`: panelin API, tarayıcı, dalga doğruluğu (ffmpeg ile), çevrimdışı arayüz ve sahte sunucuyla YouTube testleri; geçici `.test-work` kopyasında çalışır, gerçek projeye dokunmaz.
- `STUDIO_TEST_VIDEO=<klip> npm run test:studio`: gerçek render, kalan süre ve gerçek Short da eklenir.
- Yazı tipleri `public/fonts` içinde (`scripts/vendor-fonts.mjs`), render ve arayüz internet istemez. İnternet gereken tek yerler sohbet (Claude) ve YouTube yükleme.
- YouTube: istemci dosyası ve token `%LOCALAPPDATA%KurguAtolyesi` içinde. Google, doğrulanmamış API projesinden yüklenen videoları özel tutar; herkese açık için proje denetimi gerekir.
