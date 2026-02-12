import { categories, phrases, locationPhrases, siteInfo, programData, diplomacyData, shoppingData, infoContent, locations, participants  } from './data.js';

// --- Service Worker & Offline ---
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => {});
    });
}
window.addEventListener('online', () => document.getElementById('offlineIndicator').classList.remove('show'));
window.addEventListener('offline', () => document.getElementById('offlineIndicator').classList.add('show'));
if (!navigator.onLine) document.getElementById('offlineIndicator').classList.add('show');


// --- State & Değişkenler ---
let state = {
    view: 'program',
    day: 'all',
    category: 'all',
    diploFilter: 'all',
    favorites: JSON.parse(localStorage.getItem('tkb_favorites') || '[]'),
    expanded: null,
    settings: { voice: true, rate: 0.9, repeat: false },
    euroRate: 38.50,
    userLocation: null
};

let speakingEl = null;
let speechSynth = window.speechSynthesis;
let voices = [];
let map = null;
let markers = [];
let userMarker = null;

// --- Sabitler & Renkler ---
const dayColors = { 1: '#3498db', 2: '#e74c3c', 3: '#9b59b6', 4: '#27ae60', 5: '#f39c12' };
const categoryColors = {
    airport: '#8e44ad',
    hotel: '#e67e22',
    sight: '#3498db',
    recommendation: '#27ae60'
};
const dayNames = { 1: '1. Gün - Lizbon', 2: '2. Gün - Sevilla', 3: '3. Gün - Córdoba/Granada', 4: '4. Gün - Granada', 5: '5. Gün - Malaga/Dönüş' };

// CSV Şehir Eşleştirmesi
const cityToDayMap = {
    'İstanbul': 1,
    'Lizbon': 1,
    'Sevilla': 2,
    'Cordoba': 3,
    'Granada': 4,
    'Malaga': 5
};

// CSV Kategori Eşleştirmesi
const categoryToTypeMap = {
    'Havalimanı': 'airport',
    'Oteller': 'hotel',
    'Şehir Turu': 'sight',
    'Öneri Mekanlar': 'recommendation'
};


// --- CSV Yükleme Fonksiyonu ---
async function loadLocationsFromCSV() {
    try {
        const response = await fetch('data/locations.csv');
        if (!response.ok) throw new Error("CSV dosyası bulunamadı");
        
        const csvText = await response.text();
        
        Papa.parse(csvText, {
            header: true,
            skipEmptyLines: true,
            complete: (results) => {
                results.data.forEach(row => {
                    const name = row['Mekan / Lokasyon Adı'];
                    const city = row['Şehir'];
                    const category = row['Kategori'];
                    const subCat = row['Alt Kategori'];
                    
                    // Koordinatları sayıya çevir
                    const lat = parseFloat(row['Lat']);
                    const lon = parseFloat(row['Lon']);

                    if (name && !isNaN(lat) && !isNaN(lon)) {
                        // Günü ve Tipi belirle
                        let day = cityToDayMap[city] || 1;
                        let type = categoryToTypeMap[category] || 'sight';

                        // locations nesnesini doldur
                        locations[name] = {
                            coords: [lat, lon],
                            day: day,
                            type: type,
                            city: city,
                            subCat: subCat
                        };
                    }
                });
                
                // Veriler yüklendi, haritayı güncelle
                console.log(`CSV Yüklendi: ${Object.keys(locations).length} lokasyon.`);
                updateMapMarkers();
            }
        });
    } catch (error) {
        console.error("CSV Hatası:", error);
        toast("Harita verileri yüklenemedi!");
    }
}

// --- KATILIMCI CSV İŞLEMLERİ ---

async function loadParticipantsFromCSV() {
    try {
        const response = await fetch('data/participants.csv');
        if (!response.ok) throw new Error("Katılımcı CSV dosyası bulunamadı");
        
        const csvText = await response.text();
        
        Papa.parse(csvText, {
            header: true,
            skipEmptyLines: true,
            complete: (results) => {
                processParticipants(results.data);
            }
        });
    } catch (error) {
        console.error("Katılımcı CSV Hatası:", error);
    }
}

function processParticipants(data) {
    const grouped = {};
    
    data.forEach(p => {
        // İsim yoksa atla
        if (!p['İsim']) return;

        // --- YENİ MANTIK: Ünvan Kontrolü ---
        // Eğer Ünvan boşsa, bu bir destek personelidir.
        // 'İl' sütunundaki veriyi alıp 'Ekibi' ekliyoruz.
        // Örn: İl='Ulaşım' -> Ünvan='Ulaşım Ekibi'
        if (!p['Ünvan'] || p['Ünvan'].trim() === '') {
            const ekipTuru = p['İl'] ? p['İl'].trim() : 'Destek'; // İl boşsa 'Destek' yaz
            p['Ünvan'] = `${ekipTuru} Ekibi`; 
            p['isSupport'] = true; // Destek personeli bayrağı
        } else {
            p['isSupport'] = false;
        }

        // Belediye Adı boşsa (Destek ekibi olabilir), "Organizasyon" veya İl bilgisini kullan
        let muni = p['Belediye Adı'] ? p['Belediye Adı'].trim() : (p['İl'] ? p['İl'] + ' Ekibi' : 'Diğer');
        
        // Veriyi düzelt: Belediye Adı yoksa atanan değeri kullan
        p['Belediye Adı'] = muni;

        if (!grouped[muni]) grouped[muni] = [];
        grouped[muni].push(p);
    });

    const processedList = [];

    Object.values(grouped).forEach(group => {
        // Grupta Başkan ve Başkan Eşi var mı bak (Destek ekiplerinde bu aranmaz)
        const baskan = group.find(x => !x.isSupport && x['Ünvan'] && (x['Ünvan'].includes('Başkan') && !x['Ünvan'].includes('Eşi') && !x['Ünvan'].includes('Yardımcısı')));
        const esi = group.find(x => !x.isSupport && x['Ünvan'] && x['Ünvan'].includes('Başkan Eşi'));

        if (baskan && esi) {
            // Çift Kartı
            processedList.push({
                type: 'couple',
                p1: baskan,
                p2: esi,
                searchString: generateSearchString(baskan) + " " + generateSearchString(esi)
            });

            // Geri kalanları tekli ekle
            group.forEach(person => {
                if (person !== baskan && person !== esi) {
                    processedList.push({
                        type: person.isSupport ? 'support' : 'single', // Tipi belirle
                        p1: person,
                        searchString: generateSearchString(person)
                    });
                }
            });
        } else {
            // Eşleşme yoksa herkesi tekli ekle
            group.forEach(person => {
                processedList.push({
                    type: person.isSupport ? 'support' : 'single', // Tipi belirle
                    p1: person,
                    searchString: generateSearchString(person)
                });
            });
        }
    });

    // Listeyi güncelle
    participants.length = 0;
    processedList.forEach(p => participants.push(p));
    
    console.log(`Katılımcılar Yüklendi: ${participants.length} kart.`);
    renderParticipants();
}

function generateSearchString(p) {
    // Tüm sütunlardaki verileri birleştirip küçük harfe çevirir
    return Object.values(p).join(' ').toLocaleLowerCase('tr');
}

function renderParticipants(filterText = '') {
    const container = document.getElementById('participantsContainer');
    if (!container) return;

    let html = '';
    const searchLower = filterText.toLocaleLowerCase('tr');

    const filtered = participants.filter(item => {
        if (!searchLower) return true;
        return item.searchString.includes(searchLower);
    });

    if (filtered.length === 0) {
        container.innerHTML = '<div class="empty-state"><div class="empty-icon">🔍</div><div class="empty-text">Aradığınız kriterlere uygun kayıt bulunamadı.</div></div>';
        return;
    }

    filtered.forEach(item => {
        const p1 = item.p1;
        
        // Lojistik
        const busL = p1['Lizbon Otobüs'] || '-';
        const busS = p1['Sevilla Otobüs'] || '-';
        const busG = p1['Granada Otobüs'] || '-';
        const room = p1['Oda Tipi'] || 'STD';
        
        // Oteller
        const hotels = [
            { city: 'LIZ', name: p1['Lizbon Otel'] || '-' },
            { city: 'SEV', name: p1['Sevilla Otel'] || '-' },
            { city: 'GRA', name: p1['Granada Otel'] || '-' }
        ];

        // İletişim Satırları
        let contactsHtml = '';
        
        // 1. Kişi
        if (p1['Telefon']) {
            contactsHtml += `
            <div class="contact-row">
                <div class="contact-icon-wrap">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                </div>
                <div class="contact-details">
                    <div class="contact-name">${p1['İsim']} ${p1['Soyisim']}</div>
                    <div class="contact-number">${p1['Telefon']}</div>
                </div>
                <a href="tel:${p1['Telefon']}" class="contact-btn">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                </a>
            </div>`;
        }

        // 2. Kişi (Eş)
        if (item.type === 'couple' && item.p2['Telefon']) {
            contactsHtml += `
            <div class="contact-row">
                <div class="contact-icon-wrap">
                     <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                </div>
                <div class="contact-details">
                    <div class="contact-name">${item.p2['İsim']} ${item.p2['Soyisim']}</div>
                    <div class="contact-number">${item.p2['Telefon']}</div>
                </div>
                <a href="tel:${item.p2['Telefon']}" class="contact-btn">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                </a>
            </div>`;
        }

        // Özel Kalem
        if (p1['Özel Kalem Telefon']) {
            contactsHtml += `
            <div class="contact-row" style="border-left:2px solid var(--border-subtle); margin-left:6px;">
                <div class="contact-details">
                    <div class="contact-name" style="font-size:11px; text-transform:uppercase; color:var(--text-muted)">Özel Kalem / Asistan</div>
                    <div class="contact-name">${p1['Özel Kalem Ad Soyad'] || ''}</div>
                    <div class="contact-number">${p1['Özel Kalem Telefon']}</div>
                </div>
                <a href="tel:${p1['Özel Kalem Telefon']}" class="contact-btn">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                </a>
            </div>`;
        }

        // Header İsimler
        let namesHtml = '';
        if (item.type === 'couple') {
            namesHtml = `
                <div class="part-name">${p1['İsim']} ${p1['Soyisim']}</div>
                <div class="part-role">${p1['Ünvan']}</div>
                <div class="part-name" style="margin-top:8px; font-size:16px; opacity:0.9">${item.p2['İsim']} ${item.p2['Soyisim']}</div>
                <div class="part-role" style="font-size:10px">${item.p2['Ünvan']}</div>
            `;
        } else {
            namesHtml = `
                <div class="part-name">${p1['İsim']} ${p1['Soyisim']}</div>
                <div class="part-role">${p1['Ünvan']}</div>
            `;
        }

        // Kart Oluşturma
        const muniLabel = p1['Belediye Adı'];

        html += `
        <div class="part-card ${item.type}">
            <!-- HEADER -->
            <div class="part-header">
                <div class="part-identity">
                    ${namesHtml}
                    <div class="part-muni-tag">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21h18M5 21V7l8-4 8 4v14M8 21v-2a2 2 0 0 1 4 0v2"/></svg>
                        ${muniLabel}
                    </div>
                </div>
                <div class="room-badge">
                    <span class="room-icon">🛏️</span>
                    <span class="room-text">${room.substring(0, 5)}</span>
                </div>
            </div>

            <!-- LOJİSTİK -->
            <div class="logistics-bar">
                <div class="bus-pill"><span class="bus-city">L</span><span class="bus-name">${busL}</span></div>
                <div class="bus-pill"><span class="bus-city">S</span><span class="bus-name">${busS}</span></div>
                <div class="bus-pill"><span class="bus-city">G</span><span class="bus-name">${busG}</span></div>
            </div>

            <!-- BODY -->
            <div class="part-body">
                <div class="contact-list">
                    ${contactsHtml}
                </div>

                <div class="hotel-timeline">
                    ${hotels.map(h => `
                    <div class="hotel-row">
                        <div class="hotel-dot"></div>
                        <div class="hotel-info">
                            <span class="hotel-city-label">${h.city}</span>
                            <span class="hotel-name-label">${h.name}</span>
                        </div>
                    </div>`).join('')}
                </div>
            </div>
        </div>`;
    });

    container.innerHTML = html;
}


// --- Harita Fonksiyonları ---
function createCustomIcon(color) {
    return L.divIcon({
        className: 'custom-marker',
        html: `<div style="background:${color};width:24px;height:24px;border-radius:50%;border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.4);"></div>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
        popupAnchor: [0, -12]
    });
}

function createUserIcon() {
    return L.divIcon({
        className: 'user-marker',
        html: '<div style="background:#00bcd4;width:20px;height:20px;border-radius:50%;border:3px solid white;box-shadow:0 0 10px rgba(0,188,212,0.5);"></div>',
        iconSize: [20, 20],
        iconAnchor: [10, 10],
        popupAnchor: [0, -10]
    });
}

function initMap() {
    if (map) return;
    map = L.map('programMap', { zoomControl: true, scrollWheelZoom: true }).setView([38.0, -5.0], 6);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: 'OpenStreetMap & CARTO',
        subdomains: 'abcd',
        maxZoom: 19
    }).addTo(map);
    
    // Harita ilk yüklendiğinde markerları koy (Eğer CSV hızlı yüklendiyse)
    updateMapMarkers();
}

function updateMapMarkers() {
    if (!map) return;
    
    // Eski markerları temizle
    markers.forEach(m => map.removeLayer(m));
    markers = [];
    const bounds = [];

    Object.entries(locations).forEach(([name, loc]) => {
        // Filtreleme: Eğer 'Tümü' seçili değilse, sadece o günün lokasyonlarını göster
        if (state.day !== 'all' && loc.day !== state.day) return;

        let color = categoryColors[loc.type] || dayColors[loc.day];
        
        const marker = L.marker(loc.coords, { icon: createCustomIcon(color) })
            .addTo(map)
            .bindPopup(`<div class="popup-title">${name}</div><div class="popup-time">${loc.subCat || loc.type}</div><div class="popup-location">${loc.city}</div>`);
            
        markers.push(marker);
        bounds.push(loc.coords);
    });

    if (bounds.length > 0) {
        if (bounds.length === 1) map.setView(bounds[0], 13);
        else map.fitBounds(bounds, { padding: [50, 50] });
    }
}

function locateUser() {
    const btn = document.getElementById('locateBtn');
    if (!navigator.geolocation) { toast('Konum servisi kullanılamıyor'); return; }
    btn.classList.add('locating');
    navigator.geolocation.getCurrentPosition((position) => {
        btn.classList.remove('locating');
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        if (userMarker) map.removeLayer(userMarker);
        userMarker = L.marker([lat, lng], { icon: createUserIcon() }).addTo(map).bindPopup('<div class="popup-title">📍 Konumunuz</div>').openPopup();
        map.setView([lat, lng], 15);
        toast('Konumunuz haritada gösteriliyor');
    }, (error) => {
        btn.classList.remove('locating');
        toast('Konum alınamadı');
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
}


// --- Ses (TTS) Fonksiyonları ---
const langMap = { 'en': ['en-GB', 'en-US'], 'es': ['es-ES', 'es-MX'], 'pt': ['pt-PT', 'pt-BR'] };

function loadVoices() {
    voices = speechSynth.getVoices();
    if (voices.length === 0) speechSynth.onvoiceschanged = () => { voices = speechSynth.getVoices(); };
}

function findVoice(lang) {
    const preferred = langMap[lang] || [lang];
    for (const pref of preferred) {
        let voice = voices.find(v => v.lang === pref || v.lang.startsWith(pref.split('-')[0]));
        if (voice) return voice;
    }
    return voices[0];
}

// Window'a bağlıyoruz çünkü HTML onclick içinde kullanılıyor
window.speak = function(text, lang, btn) {
    if (!state.settings.voice) return;
    speechSynth.cancel();
    if (speakingEl) speakingEl.classList.remove('speaking');
    const utterance = new SpeechSynthesisUtterance(text);
    const voice = findVoice(lang);
    if (voice) { utterance.voice = voice; utterance.lang = voice.lang; }
    utterance.rate = state.settings.rate;
    if (btn) { btn.classList.add('speaking'); speakingEl = btn; }
    utterance.onend = () => { if (btn) btn.classList.remove('speaking'); speakingEl = null; };
    utterance.onerror = () => { if (btn) btn.classList.remove('speaking'); };
    speechSynth.speak(utterance);
}

window.speakAll = function(en, es, pt) {
    speechSynth.cancel();
    const queue = [{ text: en, lang: 'en' }, { text: es, lang: 'es' }, { text: pt, lang: 'pt' }];
    let i = 0;
    function next() {
        if (i >= queue.length) return;
        const item = queue[i];
        const u = new SpeechSynthesisUtterance(item.text);
        const v = findVoice(item.lang);
        if (v) { u.voice = v; u.lang = v.lang; }
        u.rate = state.settings.rate;
        u.onend = () => { i++; setTimeout(next, 400); };
        speechSynth.speak(u);
    }
    next();
}


// --- Döviz Fonksiyonları ---
async function fetchExchangeRate() {
    try {
        const res = await fetch('https://api.exchangerate-api.com/v4/latest/EUR');
        const data = await res.json();
        if (data.rates && data.rates.TRY) {
            state.euroRate = data.rates.TRY;
            updateConverterRate();
        }
    } catch (e) { }
}

function updateConverterRate() {
    const el = document.getElementById('converterRate');
    if (el) el.innerHTML = 'Güncel kur: <strong>1 € = ' + state.euroRate.toFixed(2) + ' ₺</strong>';
}

window.convertCurrency = function(from) {
    const euroInput = document.getElementById('euroInput');
    const tlInput = document.getElementById('tlInput');
    if (from === 'euro') {
        const euro = parseFloat(euroInput.value) || 0;
        tlInput.value = (euro * state.euroRate).toFixed(2);
    } else {
        const tl = parseFloat(tlInput.value) || 0;
        euroInput.value = (tl / state.euroRate).toFixed(2);
    }
}

window.swapCurrency = function() {
    const e = document.getElementById('euroInput');
    const t = document.getElementById('tlInput');
    const temp = e.value;
    e.value = t.value;
    t.value = temp;
}


// --- Arayüz Yönetimi ---
function updateDaySelector() {
    const daySelector = document.getElementById('daySelector');
    const diploSelector = document.getElementById('diploSelector');
    const main = document.getElementById('mainContent');
    daySelector.classList.remove('visible');
    diploSelector.classList.remove('visible');
    main.classList.remove('with-days');
    if (state.view === 'program') {
        daySelector.classList.add('visible');
        main.classList.add('with-days');
    } else if (state.view === 'diplomacy') {
        diploSelector.classList.add('visible');
        main.classList.add('with-days');
    }
}

function renderPills() {
    const el = document.getElementById('categoryPills');
    el.innerHTML = '<button class="pill ' + (state.category === 'all' ? 'active' : '') + '" data-cat="all"><span class="emoji">📚</span>Tümü</button>' + categories.map(c => '<button class="pill ' + (state.category === c.id ? 'active' : '') + '" data-cat="' + c.id + '"><span class="emoji">' + c.emoji + '</span>' + c.name + '</button>').join('');
}

function renderPhrases() {
    const container = document.getElementById('phrasesContainer');
    let cats = state.category === 'all' ? categories : categories.filter(c => c.id === state.category);
    container.innerHTML = cats.map(cat => {
        const items = phrases[cat.id] || [];
        return '<div class="section"><div class="section-header"><h2 class="section-title"><span class="icon">' + cat.emoji + '</span>' + cat.name + '</h2><span class="section-badge">' + items.length + ' ifade</span></div><div class="phrase-grid">' + items.map((p, i) => renderCard(p, cat.id, i)).join('') + '</div></div>';
    }).join('');
}

function renderCard(p, catId, idx) {
    const id = catId + '-' + idx;
    const isFav = state.favorites.includes(id);
    const isExp = state.expanded === id;
    return '<div class="phrase-card ' + (isExp ? 'expanded' : '') + '" data-id="' + id + '"><div class="card-header" onclick="toggleCard(\'' + id + '\')"><span class="turkish-phrase">' + p.tr + '</span><div class="expand-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg></div></div><div class="card-body"><div class="card-content"><div class="translation-row"><span class="lang-tag en">EN</span><span class="translation-text">' + p.en + '</span><button class="speak-btn" onclick="event.stopPropagation();speak(\'' + p.en.replace(/'/g, "\\'") + '\',\'en\',this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg></button></div><div class="translation-row"><span class="lang-tag es">ES</span><span class="translation-text">' + p.es + '</span><button class="speak-btn" onclick="event.stopPropagation();speak(\'' + p.es.replace(/'/g, "\\'") + '\',\'es\',this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg></button></div><div class="translation-row"><span class="lang-tag pt">PT</span><span class="translation-text">' + p.pt + '</span><button class="speak-btn" onclick="event.stopPropagation();speak(\'' + p.pt.replace(/'/g, "\\'") + '\',\'pt\',this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg></button></div><div class="card-actions"><button class="action-btn favorite ' + (isFav ? 'active' : '') + '" onclick="event.stopPropagation();toggleFav(\'' + id + '\')"><svg viewBox="0 0 24 24" fill="' + (isFav ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>' + (isFav ? 'Favorilerde' : 'Favorilere Ekle') + '</button><button class="action-btn" onclick="event.stopPropagation();speakAll(\'' + p.en.replace(/'/g, "\\'") + '\',\'' + p.es.replace(/'/g, "\\'") + '\',\'' + p.pt.replace(/'/g, "\\'") + '\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>Tümünü Dinle</button></div></div></div></div>';
}

window.toggleCard = function(id) {
    state.expanded = state.expanded === id ? null : id;
    renderPhrases();
    if (state.view === 'favorites') renderFavorites();
}

function renderProgram() {
    const el = document.getElementById('programContent');
    const data = state.day === 'all' ? programData : programData.filter(d => d.day === state.day);
    el.innerHTML = data.map(day => '<div class="section" style="padding:0 20px;margin-bottom:12px"><div class="section-header"><h2 class="section-title"><span class="icon">📅</span>' + day.date + ' — ' + day.city + '</h2></div></div>' + day.events.map(ev => renderProgramCard(ev)).join('')).join('');
    setTimeout(() => {
        if (!map) initMap();
        else {
            updateMapMarkers();
            map.invalidateSize();
        }
    }, 100);
}

function renderProgramCard(ev) {
    const siteInfoHtml = ev.sites && ev.sites.length > 0 ? ev.sites.map(s => {
        const info = siteInfo[s];
        if (!info) return '';
        const wikiBtn = info.wiki ? `<a href="${info.wiki}" target="_blank" class="site-info-link"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3"/></svg>Wikipedia</a>` : '';
        return `<div class="site-info"><div class="site-info-title"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>${s}</div><div class="site-info-text">${info.desc}</div><div class="site-info-links">${wikiBtn}<a href="${info.maps}" target="_blank" class="site-info-link maps"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>Haritada Aç</a></div></div>`;
    }).join('') : '';

    const noteHtml = ev.note ? `<div class="program-note" style="font-size:13px;color:var(--gold-primary);background:var(--bg-tertiary);padding:10px;border-radius:8px;margin-bottom:12px;border:1px dashed var(--border-gold);"><strong>ℹ️ Not:</strong> ${ev.note}</div>` : '';

    let shoppingHtml = '';
    if (ev.cats && ev.cats.includes('shopping')) {
        const cityKey = Object.keys(shoppingData).find(key => ev.location.toLowerCase().includes(shoppingData[key].city.toLowerCase()) || ev.title.toLowerCase().includes(shoppingData[key].city.toLowerCase()));
        const sData = shoppingData[cityKey];
        if (sData) {
            shoppingHtml = `
            <div class="quick-phrases-label" style="margin-top:20px;">🛍️ Alışveriş Önerileri</div>
            <div class="shopping-body" style="padding:0;">
                ${sData.items.map(item => `
                    <div class="shopping-item" style="background:var(--bg-tertiary); padding:12px; border-radius:12px; margin-bottom:10px; border:1px solid var(--border-subtle);">
                        <div class="shopping-item-icon">${item.icon}</div>
                        <div class="shopping-item-content">
                            <div class="shopping-item-name">${item.name}</div>
                            <div class="shopping-item-desc">${item.desc}</div>
                            <div class="shopping-item-price">Ort. ${item.price}</div>
                        </div>
                    </div>
                `).join('')}
            </div>`;
        }
    }

    return `
    <div class="program-card">
        <div class="program-header">
            <span class="program-time"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>${ev.time}</span>
            <div class="program-title">${ev.title}</div>
            <div class="program-location"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>${ev.location}</div>
        </div>
        <div class="program-body">${noteHtml}${siteInfoHtml}${shoppingHtml}</div>
    </div>`;
}

function renderFavorites() {
    const el = document.getElementById('favoritesContainer');
    if (state.favorites.length === 0) {
        el.innerHTML = '<div class="empty-state"><div class="empty-icon">⭐</div><div class="empty-title">Henüz favori yok</div><div class="empty-text">Sık kullandığınız ifadeleri yıldız butonuyla favorilere ekleyebilirsiniz.</div></div>';
        return;
    }
    const items = state.favorites.map(f => {
        const [c, i] = f.split('-');
        const p = phrases[c]?.[parseInt(i)];
        return p ? { p, c, i: parseInt(i) } : null;
    }).filter(Boolean);
    el.innerHTML = '<div class="section" style="padding:0 20px"><div class="phrase-grid">' + items.map(x => renderCard(x.p, x.c, x.i)).join('') + '</div></div>';
}

function renderDiplomacy() {
    const el = document.getElementById('diplomacyView');
    if (!el) return;
    let html = '';
    const keysToRender = state.diploFilter === 'all' ? ['portugal', 'spain', 'cities', 'cultural'] : [state.diploFilter];
    keysToRender.forEach(key => {
        const d = diplomacyData[key];
        if (!d) return;
        html += `<div class="diplo-card"><div class="diplo-card-header ${key}"><div class="diplo-country-info"><span class="diplo-flag">${d.flag}</span><span class="diplo-country-name">${d.name}</span></div><span class="diplo-status">${d.status}</span></div><div class="diplo-card-body">${d.sections ? d.sections.map(section => `<div class="diplo-section"><div class="diplo-section-header"><div class="diplo-section-icon">${section.icon || 'ℹ️'}</div><div class="diplo-section-title">${section.title}</div></div>${Array.isArray(section.items) ? section.items.map(item => `<div class="diplo-item ${item.highlight ? 'highlight' : ''}">${item.date ? `<div class="diplo-item-date"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>${item.date}</div>` : ''}<div class="diplo-item-text">${item.text || item}</div></div>`).join('') : (section.text ? `<div class="diplo-item"><div class="diplo-item-text">${section.text}</div></div>` : '')}</div>`).join('') : ''}</div></div>`;
    });
    el.innerHTML = html || '<div class="empty-state">İçerik yüklenemedi.</div>';
}

function renderAbout() {
    return `<div class="about-card"><div class="about-header"><div class="about-logo"><img src="https://www.tarihikentlerbirligi.org/wp-content/uploads/TKBLogoSeffaf-1.png" alt="TKB" onerror="this.parentElement.textContent='TKB'"></div><div class="about-title">Dijital Resmi Heyet Rehberi</div><div class="about-subtitle">Pilot Uygulama</div><div class="about-version">Sürüm 1.2.0 • Şubat 2026</div></div><div class="about-text"><p>Bu uygulama, resmi heyetlerin yurt dışı ziyaretlerinde program, mekânsal bilgi ve iletişim ihtiyaçlarını tek bir dijital platformda toplamak amacıyla geliştirilmiştir.</p></div><div class="pilot-badge">🧪 Pilot Uygulama</div><div class="about-section-title">📝 Geri Bildirim</div><div class="about-text"><p>Görüşleriniz, uygulamanın geliştirilmesi ve gelecek organizasyonlar için değerlendirme yapılabilmesi açısından önemlidir.</p></div><div class="feedback-form"><textarea class="feedback-textarea" id="feedbackText" placeholder="Görüş, öneri veya karşılaştığınız sorunları buraya yazabilirsiniz..."></textarea><button class="feedback-btn" onclick="submitFeedback()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m22 2-7 20-4-9-9-4 20-7z"/><path d="M22 2 11 13"/></svg>Geri Bildirim Gönder</button></div></div>`;
}

window.submitFeedback = function() {
    const text = document.getElementById('feedbackText').value.trim();
    if (!text) { toast('Lütfen geri bildiriminizi yazın'); return; }
    const subject = encodeURIComponent("TKB Rehber Uygulaması Geri Bildirim");
    const body = encodeURIComponent(text);
    window.location.href = `mailto:mihrac.nar@outlook.com?subject=${subject}&body=${body}`;
    toast('E-posta taslağı oluşturuldu ✓');
    document.getElementById('feedbackText').value = '';
}

function renderInfo() {
    state.euroRate = 51.94; // Şubat 2026 tahmini
    const converterHtml = `<div class="info-card"><div class="info-card-title"><span class="emoji">💱</span>Euro - TL Çevirici</div><div class="converter-box"><div class="converter-row"><div class="converter-input-wrap"><div class="converter-label">Euro</div><span class="converter-currency">€</span><input type="number" class="converter-input" id="euroInput" placeholder="0.00" oninput="convertCurrency('euro')"></div><button class="converter-swap" onclick="swapCurrency()"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 16V4m0 0L3 8m4-4 4 4M17 8v12m0 0 4-4m-4 4-4-4"/></svg></button><div class="converter-input-wrap"><div class="converter-label">Türk Lirası</div><span class="converter-currency">₺</span><input type="number" class="converter-input" id="tlInput" placeholder="0.00" oninput="convertCurrency('tl')"></div></div><div class="converter-rate" id="converterRate">Güncel kur: <strong>1 € = ${state.euroRate.toFixed(2)} ₺</strong></div></div></div>`;
    const baseInfoCards = infoContent.map(s => `<div class="info-card"><div class="info-card-title"><span class="emoji">${s.emoji}</span>${s.title}</div>${s.items.map(i => `<div class="info-item"><span class="info-icon">${i.icon}</span><span>${i.text}</span></div>`).join('')}</div>`).join('');
    const aboutHeaderHtml = `<div class="section" style="padding:0 20px;margin-bottom:12px"><div class="section-header"><h2 class="section-title"><span class="icon">ℹ️</span>Uygulama Hakkında</h2></div></div>`;
    document.getElementById('infoView').innerHTML = converterHtml + baseInfoCards + aboutHeaderHtml + renderAbout();
}

window.toggleFav = function(id) {
    const i = state.favorites.indexOf(id);
    if (i > -1) { state.favorites.splice(i, 1); toast('Favorilerden çıkarıldı'); }
    else { state.favorites.push(id); toast('Favorilere eklendi ⭐'); }
    localStorage.setItem('tkb_favorites', JSON.stringify(state.favorites));
    renderPhrases();
    if (state.view === 'favorites') renderFavorites();
}

function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2500);
}

function switchView(v) {
    state.view = v;
    document.querySelectorAll('.nav-tab').forEach(n => n.classList.toggle('active', n.dataset.view === v));
    document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
    document.getElementById(v + 'View').classList.add('active');
    updateDaySelector();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (v === 'program') {
        renderProgram();
        // Harita container'ı visible olduğunda boyutunu güncelle
        setTimeout(() => {
            if (map) {
                map.invalidateSize();
                updateMapMarkers();
            }
        }, 200);
    } else if (v === 'phrases') renderPhrases();
    else if (v === 'favorites') renderFavorites();
    else if(v === 'participants') {
    // Görünüm açıldığında listeyi tekrar render et (belki search temizlenmiştir)
    // İsterseniz inputu temizleyebilirsiniz: document.getElementById('participantSearchInput').value = '';
    renderParticipants(document.getElementById('participantSearchInput')?.value || '');
}
    else if (v === 'diplomacy') renderDiplomacy();
    else if (v === 'info') renderInfo();
}

function switchDay(d) {
    state.day = d === 'all' ? 'all' : parseInt(d);
    document.querySelectorAll('.day-chip').forEach(c => c.classList.toggle('active', c.dataset.day === d));
    if (state.view === 'program') {
        renderProgram();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
}

function switchDiploFilter(f) {
    state.diploFilter = f;
    document.querySelectorAll('.diplo-chip').forEach(c => c.classList.toggle('active', c.dataset.filter === f));
    renderDiplomacy();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function switchCategory(c) {
    state.category = c;
    state.expanded = null;
    document.querySelectorAll('.pill').forEach(p => p.classList.toggle('active', p.dataset.cat === c));
    renderPhrases();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function search(q) {
    const res = [];
    if (q.length < 2) return res;
    const ql = q.toLowerCase();
    Object.entries(phrases).forEach(([c, ps]) => ps.forEach((p, i) => {
        if (p.tr.toLowerCase().includes(ql) || p.en.toLowerCase().includes(ql) || p.es.toLowerCase().includes(ql) || p.pt.toLowerCase().includes(ql)) res.push({ p, c, i });
    }));
    return res;
}

function renderSearchResults(q) {
    const el = document.getElementById('searchResults');
    const res = search(q);
    if (q.length < 2) { el.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:60px 20px">En az 2 karakter girin...</p>'; return; }
    if (!res.length) { el.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:60px 20px">Sonuç bulunamadı</p>'; return; }
    el.innerHTML = res.map(r => '<div class="search-result" onclick="window.closeSearch(\'' + r.c + '\')"><div style="font-weight:600;color:var(--cream);margin-bottom:8px">' + r.p.tr + '</div><div style="font-size:14px;color:var(--text-secondary)"><b style="color:var(--red-badge)">EN:</b> ' + r.p.en + '<br><b style="color:var(--orange-badge)">ES:</b> ' + r.p.es + '<br><b style="color:var(--green-badge)">PT:</b> ' + r.p.pt + '</div></div>').join('');
}

window.closeSearch = function(c) {
    document.getElementById('searchOverlay').classList.remove('open');
    document.getElementById('searchInput').value = '';
    state.category = c;
    state.view = 'phrases';
    updateDaySelector();
    renderPills();
    renderPhrases();
    document.querySelectorAll('.nav-tab').forEach(n => n.classList.toggle('active', n.dataset.view === 'phrases'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('phrasesView').classList.add('active');
}

// --- Başlatma (Init) ---
document.addEventListener('DOMContentLoaded', () => {
    loadVoices();
    renderPills();
    renderProgram();
    updateDaySelector();
    fetchExchangeRate();

    // CSV Yükleme
    loadLocationsFromCSV();
    loadParticipantsFromCSV();

    // Katılımcı Arama Inputu
const partSearchInput = document.getElementById('participantSearchInput');
if(partSearchInput) {
    partSearchInput.addEventListener('input', (e) => {
        renderParticipants(e.target.value);
    });
}

    // Event Listeners
    document.getElementById('daySelector').onclick = e => { const c = e.target.closest('.day-chip'); if (c) switchDay(c.dataset.day); };
    document.getElementById('diploSelector').onclick = e => { const c = e.target.closest('.diplo-chip'); if (c) switchDiploFilter(c.dataset.filter); };
    document.getElementById('categoryPills').onclick = e => { const p = e.target.closest('.pill'); if (p) switchCategory(p.dataset.cat); };
    document.querySelectorAll('.nav-tab').forEach(n => n.onclick = () => switchView(n.dataset.view));
    document.getElementById('searchBtn').onclick = () => { document.getElementById('searchOverlay').classList.add('open'); document.getElementById('searchInput').focus(); };
    document.getElementById('searchClose').onclick = () => document.getElementById('searchOverlay').classList.remove('open');
    document.getElementById('searchInput').oninput = e => renderSearchResults(e.target.value);
    document.getElementById('settingsBtn').onclick = () => document.getElementById('settingsOverlay').classList.add('open');
    document.getElementById('settingsOverlay').onclick = e => { if (e.target === document.getElementById('settingsOverlay')) document.getElementById('settingsOverlay').classList.remove('open'); };
    document.getElementById('toggleVoice').onclick = function() { this.classList.toggle('active'); state.settings.voice = this.classList.contains('active'); };
    document.getElementById('toggleRepeat').onclick = function() { this.classList.toggle('active'); state.settings.repeat = this.classList.contains('active'); };
    document.querySelectorAll('.speed-opt').forEach(b => b.onclick = function() { document.querySelectorAll('.speed-opt').forEach(x => x.classList.remove('active')); this.classList.add('active'); state.settings.rate = parseFloat(this.dataset.rate); });
    document.getElementById('locateBtn').onclick = locateUser;

    switchView('program');
});

let lastTouch = 0;
document.addEventListener('touchend', e => {
    const now = Date.now();
    if (now - lastTouch <= 300) e.preventDefault();
    lastTouch = now;
}, { passive: false });