//! The app's menus, laid out after the web's hub (index.html, partyLobby.ts, classLobby.ts) and
//! driven by the real server, never by made-up numbers:
//!
//!   Loading (art + world + server, a real progress bar)
//!     → Name (first launch) → Home: 교육 모드 / 함께 놀기
//!   교육 모드: 선생님 · 반 만들기 | 학생 · 반 참여하기 (k-peek: whose class → confirm) | 혼자 하기
//!   함께 놀기: 빠른 입장 | 방 만들기 | 방 목록 (live, + code) | 혼자 하기
//!     → 대기실 (members, ready, chat, host start; the start button is ALWAYS on screen — the web's
//!       phone layout scrolls it away) → 입장 (world streaming with its real count) → the field.
//!
//! Immediate mode: every frame draws the top screen from the hub / class state and answers the
//! pointer. Layout is in dp for a 412 dp tall landscape phone first, centred and capped on tablets.
//! Strings and error texts are the web's own (partyLobby.ts ERRORS, classClient.ts).

use crate::art::Art;
use crate::class::{ClassSession, Ended};
use crate::ime::TextEdit;
use crate::profile::{self, Profile, CLASS_MAX, NAME_MAX};
use crate::text::Text;
use crate::ui::{line_height, Align, ButtonStyle, Painter, Rect, TextStyle};
use craftyap_net::hub::{Connect, Hub, HubNote, HubState};
use craftyap_net::link::{Event, Link, LinkOptions};
use craftyap_net::protocol::*;
use std::collections::HashMap;

const INK: [u8; 4] = [0x1f, 0x1f, 0x1f, 0xff];
const WHITE: [u8; 4] = [0xff, 0xff, 0xff, 0xff];
const GOLD: [u8; 4] = [0xff, 0xd2, 0x1c, 0xff];
/// The web hub's palette: card text #1f2a44, glass navy (--hub-glass, denser: no backdrop blur
/// here), dimmed text on glass (--hub-dim), and the status dots.
const CARD_TEXT: [u8; 4] = [0x1f, 0x2a, 0x44, 0xff];
const CARD_MUTED: [u8; 4] = [0x5a, 0x63, 0x78, 0xff];
const DIM_TEXT: [u8; 4] = [0xff, 0xff, 0xff, 0xbd];
const GREEN_DOT: [u8; 4] = [0x4c, 0xd9, 0x64, 0xff];
const RED_DOT: [u8; 4] = [0xff, 0x5a, 0x5a, 0xff];

/// The layout grid (dp): the screen margin, the top and bottom bars.
const M: f32 = 12.0;
const TOP_BAR: f32 = 52.0;
const BOTTOM_BAR: f32 = 64.0;
/// Where content starts under the top bar.
const CONTENT_TOP: f32 = 10.0 + TOP_BAR + 14.0;
/// The navigation rail (a game client's left column) on the lobby's main screens.
const RAIL_W: f32 = 84.0;
const RAIL_ACCENT: [u8; 4] = [0xff, 0xd2, 0x1c, 0xff];
const RAIL_BADGE: [u8; 4] = [0xff, 0x5a, 0x6e, 0xff];

/// A glass panel, lineless: a soft layered shadow, the navy fill (the blue frame: a blue fill), a
/// light top half. Drawn in code, no 9-slice (crisp at any size); `blue`: the blue panel tint.
fn glass(ui: &mut Ui, r: Rect, blue: bool) {
    let rad = (r.h / 2.0).min(20.0);
    ui.p.rect(r.x + 2.0, r.y + 8.0, r.w - 4.0, r.h, rad, [0x05, 0x0f, 0x28, 0x2a]);
    ui.p.rect(r.x - 1.0, r.y + 3.0, r.w + 2.0, r.h + 2.0, rad + 1.0, [0x05, 0x0f, 0x28, 0x22]);
    let fill = if blue { [0x1f, 0x4f, 0x9c, 0xec] } else { [0x18, 0x26, 0x4a, 0xea] };
    ui.p.rect(r.x, r.y, r.w, r.h, rad, fill);
    ui.p.rect(r.x + 2.0, r.y + 2.0, r.w - 4.0, (r.h * 0.5).max(rad), rad - 1.0, [0xff, 0xff, 0xff, 0x12]);
}

/// A white card, lineless: a soft layered shadow and a white face (picked or pressed: a yellow
/// ring). Returns the inner area content is laid out in.
fn white_card(ui: &mut Ui, r: Rect, pressed: bool) -> Rect {
    let rad = 22.0;
    if !pressed {
        ui.p.rect(r.x + 6.0, r.y + 14.0, r.w - 12.0, r.h, rad, [0x0a, 0x14, 0x32, 0x26]);
    }
    ui.p.rect(r.x, r.y + 4.0, r.w, r.h, rad, [0x0a, 0x14, 0x32, 0x1e]);
    if pressed {
        ui.p.rect(r.x - 4.0, r.y - 4.0, r.w + 8.0, r.h + 8.0, rad + 4.0, [0xff, 0xd2, 0x1c, 0xff]);
    }
    ui.p.rect(r.x, r.y, r.w, r.h, rad, [0xff, 0xff, 0xff, 0xff]);
    Rect::new(r.x + 14.0, r.y + 14.0, r.w - 28.0, r.h - 26.0)
}

/// The dim layer over the background art on content screens: the art stays, the content reads.
fn scrim(ui: &mut Ui, strength: f32) {
    let (w, h) = ui.screen();
    let a = |k: f32| (k * strength * 255.0) as u8;
    ui.p.rect(0.0, 0.0, w, h, 0.0, [0x0b, 0x16, 0x30, a(0.30)]);
    ui.p.rect(0.0, h * 0.55, w, h * 0.45, 0.0, [0x0b, 0x16, 0x30, a(0.22)]);
}

/// The pointer (mouse or first finger) in dp, as the app saw it this frame.
#[derive(Clone, Copy, Debug, Default)]
pub struct Pointer {
    pub pos: (f32, f32),
    pub down: bool,
    /// Went down / up during this frame.
    pub pressed: bool,
    pub released: bool,
    pub press_at: (f32, f32),
    /// Moved more than a tap allows since it went down (a scroll, not a click).
    pub dragged: bool,
    /// Vertical drag this frame (dp, + = finger moved down) and mouse wheel (dp).
    pub dy: f32,
}

/// One frame's drawing context.
pub struct Ui<'a> {
    pub p: &'a mut Painter,
    pub t: &'a mut Text,
    pub ptr: Pointer,
    /// False under the editing bar: the screen is shown but not touchable.
    pub enabled: bool,
    pub time: f32,
}

impl Ui<'_> {
    pub(crate) fn pressing(&self, r: Rect) -> bool {
        self.enabled && self.ptr.down && !self.ptr.dragged && r.contains(self.ptr.pos.0, self.ptr.pos.1) && r.contains(self.ptr.press_at.0, self.ptr.press_at.1)
    }
    fn clicked(&self, r: Rect) -> bool {
        self.enabled && self.ptr.released && !self.ptr.dragged && r.contains(self.ptr.pos.0, self.ptr.pos.1) && r.contains(self.ptr.press_at.0, self.ptr.press_at.1)
    }
    pub(crate) fn text(&mut self, s: &str, x: f32, y: f32, size: f32, color: [u8; 4], align: Align) -> f32 {
        self.p.text(self.t, s, x, y, TextStyle::new(size, color, align))
    }
    pub(crate) fn button(&mut self, r: Rect, label: &str, style: ButtonStyle, enabled: bool) -> bool {
        let pressed = self.pressing(r);
        self.p.button(self.t, r, label, style, pressed, enabled);
        enabled && self.clicked(r)
    }
    pub(crate) fn screen(&self) -> (f32, f32) {
        self.p.screen()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Screen {
    Loading,
    Name,
    Home,
    Edu,
    SoloTheme,
    Teacher,
    Student,
    /// The class exists and is open: whose it is, and "join?".
    Confirm { teacher: String },
    Games,
    /// The pet collection (the rail's 펫): adopt one of the five.
    Pets,
    /// The player's settings (the rail's 설정).
    Settings,
    Rooms,
    Create,
    Waiting,
    /// Streaming the field in.
    Entering,
    /// In the shared field (N4f draws it; until then this screen stands for it).
    InField,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Field {
    Name,
    ClassName,
    Password,
    Code,
    RoomTitle,
    Chat,
}

impl Field {
    fn max(self) -> usize {
        match self {
            Field::Name => NAME_MAX,
            Field::ClassName => CLASS_MAX,
            Field::Password => 32,
            Field::Code => 6,
            Field::RoomTitle => 20,
            Field::Chat => 120,
        }
    }
    fn placeholder(self) -> &'static str {
        match self {
            Field::Name => "내 이름 (예: 민지)",
            Field::ClassName => "반 이름 (예: 햇살반)",
            Field::Password => "반 비밀번호 (4자 이상)",
            Field::Code => "방 코드 6자리",
            Field::RoomTitle => "방 이름 (예: 같이 블록 쌓자)",
            Field::Chat => "채팅을 입력해요",
        }
    }
}

/// What the menu asks of the app.
#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    None,
    /// 혼자 하기: the island, offline.
    PlaySolo,
    PlayFire,
}

/// Loading inputs the app measures (0..1 each).
#[derive(Clone, Copy, Debug, Default)]
pub struct LoadProgress {
    pub art: f32,
    pub world: f32,
}

pub struct Menu {
    class_theme:String,
    pub profile: Profile,
    server: String,
    hub: Hub,
    stack: Vec<Screen>,
    edits: HashMap<Field, TextEdit>,
    pub focus: Option<Field>,
    toast: Option<(String, f64)>,
    /// Where this frame's content starts (dp): past the rail on the rail's screens, else 0.
    left: f32,
    peek: Option<Link>,
    class: Option<ClassSession>,
    key_saved: bool,
    /// Where the field HUD answered taps last frame.
    hud_rects: Vec<Rect>,
    create_max: u32,
    create_public: bool,
    scroll: f32,
    chat: Vec<(String, String, bool)>,
    started: f64,
    now: f64,
    progress: LoadProgress,
    /// The editing bar's rectangles last frame (touch editing), for taps.
    edit_bar: Option<(Rect, Rect)>,
    logged_state: String,
}

fn hub_connect(server: &str) -> Connect {
    let url = format!("{server}/ws?mode=party");
    Box::new(move |first| Box::new(Link::open(&url, Some(first), LinkOptions::default())))
}

fn party_error(code: &str) -> &'static str {
    match code {
        "bad-version" => "새 버전이 나왔어요. 앱을 업데이트해 주세요.",
        "bad-name" => "이름을 1~16자로 써 주세요.",
        "not-found" => "그 코드의 방을 찾지 못했어요. 코드를 다시 확인해 주세요.",
        "full" => "방이 꽉 찼어요.",
        "name-taken" => "그 방에 같은 이름이 이미 있어요. 이름을 바꿔 주세요.",
        "kicked" => "방장이 내보낸 방이에요. 잠시 뒤에 다시 들어올 수 있어요.",
        "not-host" => "방장만 할 수 있어요.",
        "not-ready" => "모두 준비해야 시작할 수 있어요.",
        "too-many-rooms" => "지금은 방을 더 만들 수 없어요. 열린 방에 들어가 보세요.",
        "game-limit" => "지금 인원으로는 그 게임을 할 수 없어요.",
        "rate" => "너무 빨라요. 잠시 뒤에 다시 해 주세요.",
        _ => "문제가 생겼어요. 다시 해 주세요.",
    }
}

fn class_error(code: &str) -> &'static str {
    match code {
        "no-class" => "그 이름의 반이 지금 열려 있지 않아요. 반 이름을 확인하거나, 선생님이 반을 열 때까지 기다려 주세요.",
        "bad-password" => "비밀번호가 맞지 않아요. 여러 번 틀리면 잠시 동안 막혀요. (새 반을 만들 때는 4자 이상)",
        "teacher-taken" => "이 반의 선생님이 이미 다른 곳에서 접속해 있어요.",
        "room-taken" => "이 반 이름은 다른 선생님이 쓰고 있어요. 다른 반 이름을 정해주세요.",
        "name-taken" => "이 반에 같은 이름의 학생이 이미 접속해 있어요.",
        "class-full" => "반 정원이 가득 찼어요.",
        "banned" => "선생님이 내보내서 잠시 동안 들어갈 수 없어요.",
        "bad-name" => "반 이름은 1~20자, 이름은 1~16자로 입력해주세요.",
        "bad-version" => "새 버전이 나왔어요. 앱을 업데이트해 주세요.",
        _ => "문제가 생겼어요. 다시 해 주세요.",
    }
}

impl Menu {
    pub fn new(profile: Profile, now: f64) -> Menu {
        let server = profile::server();
        log::info!("server: {server}");
        let name = if profile.name.is_empty() { "손님".to_owned() } else { profile.name.clone() };
        let hub = Hub::new(hub_connect(&server), &name, profile.seat.clone());
        let mut edits = HashMap::new();
        edits.insert(Field::Name, TextEdit::new(&profile.name, NAME_MAX));
        edits.insert(Field::ClassName, TextEdit::new(&profile.last_class, CLASS_MAX));
        Menu {
            class_theme:"craft".into(),
            profile,
            server,
            hub,
            stack: vec![Screen::Loading],
            edits,
            focus: None,
            toast: None,
            left: 0.0,
            peek: None,
            class: None,
            key_saved: false,
            hud_rects: Vec::new(),
            create_max: 8,
            create_public: true,
            scroll: 0.0,
            chat: Vec::new(),
            started: now,
            now,
            progress: LoadProgress::default(),
            edit_bar: None,
            logged_state: String::new(),
        }
    }

    pub fn top(&self) -> &Screen {
        self.stack.last().unwrap_or(&Screen::Home)
    }

    fn go(&mut self, s: Screen) {
        self.focus = None;
        self.scroll = 0.0;
        self.stack.push(s);
    }

    fn replace(&mut self, s: Screen) {
        self.stack.pop();
        self.go(s);
    }

    /// A short yellow notice under the top bar (3.5 s), on any screen and in play.
    pub fn toast(&mut self, s: impl Into<String>) {
        self.toast = Some((s.into(), self.now + 3.5));
    }

    pub fn edit_mut(&mut self, f: Field) -> &mut TextEdit {
        self.edits.entry(f).or_insert_with(|| TextEdit::new("", f.max()))
    }

    fn value(&self, f: Field) -> String {
        self.edits.get(&f).map(|e| e.value()).unwrap_or_default()
    }

    /// The field being typed into, if any (the app feeds the platform's text to it).
    pub fn focused_edit(&mut self) -> Option<&mut TextEdit> {
        let f = self.focus?;
        Some(self.edit_mut(f))
    }

    pub fn focus_on(&mut self, f: Option<Field>) {
        if self.focus == f {
            if let Some(f) = f {
                let text = self.edit_mut(f).text.clone();
                crate::ime::begin(&text); // a tap on the focused field brings back the keyboard
            }
            return;
        }
        self.focus = f;
        match f {
            Some(f) => {
                let text = self.edit_mut(f).text.clone();
                crate::ime::begin(&text);
            }
            None => crate::ime::end(),
        }
    }

    // ------------------------------------------------------------------------------- per frame

    pub fn update(&mut self, now: f64, progress: LoadProgress) {
        self.now = now;
        self.progress = progress;
        self.hub.tick(now - self.started);
        let state = format!("{:?}", self.hub.state);
        if state != self.logged_state {
            log::info!("hub: {state} (screen {:?})", self.top());
            self.logged_state = state;
        }
        for note in self.hub.take_notes() {
            match note {
                HubNote::Error(code) => {
                    let text = party_error(&code);
                    self.toast(text);
                }
                HubNote::Left(reason) => {
                    if reason == "kicked" {
                        self.toast("방장이 방에서 내보냈어요.");
                    }
                    self.chat.clear();
                }
                HubNote::Chat { name, text, system, .. } => {
                    self.chat.push((name, text, system));
                    if self.chat.len() > 60 {
                        self.chat.remove(0);
                    }
                }
            }
        }
        // the seat follows the server; keep it for the next launch
        if self.profile.seat.as_ref() != self.hub.seat() {
            self.profile.seat = self.hub.seat().cloned();
            self.profile.save();
        }
        // the room decides the waiting room, not the button that asked for it
        match (&self.hub.state, self.top().clone()) {
            (HubState::Room, Screen::Games | Screen::Rooms | Screen::Create | Screen::Home) => {
                while matches!(self.top(), Screen::Rooms | Screen::Create) {
                    self.stack.pop();
                }
                if *self.top() != Screen::Games {
                    self.stack.push(Screen::Games);
                }
                self.go(Screen::Waiting);
            }
            (HubState::Lobby, Screen::Waiting) => {
                self.stack.pop();
            }
            // a start goes into the game from any screen: a seat re-taken in a room that is already
            // playing gets its start right after the welcome, while the app may still be loading
            (HubState::Starting { game, code }, _) if self.class.is_none() => {
                let (game, code) = (game.clone(), code.clone());
                if game == game::BUILD {
                    let title = self.hub.room.as_ref().map(|r| r.title.clone()).unwrap_or_else(|| code.clone());
                    let name = self.hub.name().to_owned();
                    self.enter_class(party_field_name(&code), title, &name, false, None, true);
                } else {
                    self.toast("이 게임은 아직 웹(craftyap.com)에서만 할 수 있어요.");
                    self.hub.resume();
                }
            }
            _ => {}
        }
        self.update_peek();
        self.update_class();
        if self.toast.as_ref().is_some_and(|t| now > t.1) {
            self.toast = None;
        }
    }

    fn update_peek(&mut self) {
        let Some(link) = &mut self.peek else { return };
        for ev in link.poll() {
            match ev {
                Event::Text(text) => {
                    if let Some(ClassServer::Room { exists, open, teacher, .. }) = decode::<ClassServer>(&text) {
                        self.peek = None;
                        if open {
                            self.go(Screen::Confirm { teacher: teacher.unwrap_or_default() });
                        } else if exists {
                            self.toast("선생님이 아직 반을 열지 않았어요. 반이 열리면 다시 해 주세요.");
                        } else {
                            self.toast(class_error("no-class"));
                        }
                        return;
                    }
                }
                Event::Closed { .. } => {
                    self.peek = None;
                    self.toast("서버에 연결하지 못했어요. 인터넷을 확인해 주세요.");
                    return;
                }
                Event::Open => {}
            }
        }
    }

    fn enter_class(&mut self, room: String, title: String, name: &str, teacher: bool, password: Option<String>, party: bool) {
        let url = format!("{}/ws?mode=class&room={}", self.server, profile::url_encode(&room));
        let key = self.profile.class_seat(&room, teacher);
        let first = if teacher {
            ClassClient::Host { v: CLASS_PROTOCOL_VERSION, room: room.clone(), teacher: name.to_owned(), password, host_key: key, theme: (self.class_theme=="fire").then(||"fire".into()) }
        } else {
            ClassClient::Join { v: CLASS_PROTOCOL_VERSION, room: room.clone(), student: name.to_owned(), seat_key: key }
        };
        log::info!("class: entering {room} as {}", if teacher { "teacher" } else { "student" });
        let link = Link::open(&url, Some(encode(&first)), LinkOptions::default());
        self.class = Some(ClassSession::new(link, room, title, teacher, party));
        self.key_saved = false;
        self.go(Screen::Entering);
    }

    fn update_class(&mut self) {
        let now = self.now;
        let Some(c) = &mut self.class else { return };
        c.poll(now);
        // the seat / host key, once: a refresh or another launch re-takes the same seat
        if !self.key_saved {
            if let Some(key) = c.key.clone() {
                let (room, teacher) = (c.room.clone(), c.teacher);
                self.key_saved = true;
                self.profile.set_class_seat(&room, teacher, Some(key));
                self.profile.save();
            }
        }
        let Some(c) = &self.class else { return };
        if c.ready() && *self.top() == Screen::Entering {
            log::info!("class: in the field ({} edits)", c.got);
            self.replace(Screen::InField);
        }
        let Some(c) = &self.class else { return };
        let (room, teacher) = (c.room.clone(), c.teacher);
        let fail = match c.ended.clone() {
            None => return,
            Some(Ended::Error(code)) => {
                if code == "bad-password" || code == "name-taken" {
                    self.profile.set_class_seat(&room, teacher, None);
                    self.profile.save();
                }
                class_error(&code).to_owned()
            }
            Some(Ended::Kicked) => class_error("banned").to_owned(),
            Some(Ended::Closed) => "수업이 끝났어요.".to_owned(),
            Some(Ended::Lost(why)) => format!("연결이 끊겼어요. ({})", short_why(&why)),
        };
        log::warn!("class: {fail}");
        self.leave_class();
        self.toast(fail);
    }

    /// The field session while one is open (the game applies its edits and draws its classmates).
    pub fn class_mut(&mut self) -> Option<&mut ClassSession> {
        self.class.as_mut()
    }

    /// In the shared field: the game is on screen with the field HUD over it.
    pub fn in_field(&self) -> bool {
        *self.top() == Screen::InField && self.class.is_some()
    }

    /// Screen rectangles the HUD answers taps in (the rest of the screen steers the game).
    pub fn hud_hit(&self, x: f32, y: f32) -> bool {
        self.focus.is_some() || self.hud_rects.iter().any(|r| r.contains(x, y))
    }

    pub fn leave_class(&mut self) {
        let party = self.class.as_ref().is_some_and(|c| c.party);
        self.class = None;
        self.focus = None;
        while matches!(self.top(), Screen::Entering | Screen::InField) {
            self.stack.pop();
        }
        if party {
            self.hub.resume(); // back to the waiting room with the kept seat
        }
    }

    /// Android Back / Escape: close the keyboard, else go back one screen. False at the root.
    pub fn back(&mut self) -> bool {
        if self.focus.is_some() {
            self.focus_on(None);
            return true;
        }
        match self.top().clone() {
            Screen::Loading | Screen::Home => false,
            Screen::Name if self.profile.name.is_empty() => false,
            Screen::Waiting => {
                self.hub.leave();
                true
            }
            Screen::Entering | Screen::InField => {
                self.leave_class();
                true
            }
            _ => {
                self.stack.pop();
                self.focus = None;
                true
            }
        }
    }

    /// Enter on a keyboard / the keyboard's ✓: the screen's main action.
    pub fn submit(&mut self) {
        let field = self.focus;
        self.focus_on(None);
        match (self.top().clone(), field) {
            (Screen::Waiting, Some(Field::Chat)) => self.send_chat(),
            (Screen::InField, Some(Field::Chat)) => {
                let text = self.value(Field::Chat);
                if !text.is_empty() {
                    if let Some(c) = &mut self.class {
                        c.send_chat(text);
                    }
                    self.edit_mut(Field::Chat).set("");
                }
            }
            (Screen::Rooms, Some(Field::Code)) => self.join_code(),
            (Screen::Name, _) => self.save_name(),
            _ => {}
        }
    }

    fn save_name(&mut self) {
        let name = self.value(Field::Name);
        if !profile::valid_player_name(&name) {
            self.toast("이름을 1~16자로 써 주세요.");
            return;
        }
        if name != self.profile.name {
            self.profile.name = name.clone();
            self.profile.save();
            // the hub hears names in its hello: reconnect under the new one (the seat is kept)
            self.hub = Hub::new(hub_connect(&self.server), &name, self.profile.seat.clone());
        }
        if self.stack.len() > 1 && self.stack[self.stack.len() - 2] != Screen::Loading {
            self.stack.pop();
        } else {
            self.replace(Screen::Home);
        }
    }

    fn send_chat(&mut self) {
        let text = self.value(Field::Chat);
        if text.is_empty() {
            return;
        }
        self.hub.send(PartyClient::Chat { text });
        self.edit_mut(Field::Chat).set("");
    }

    fn join_code(&mut self) {
        let code: String = self.value(Field::Code).to_uppercase();
        if code.chars().count() != 6 {
            self.toast("방 코드는 6자리예요.");
            return;
        }
        self.hub.send(PartyClient::Join { code });
    }

    // ---------------------------------------------------------------------------------- drawing

    /// Draw the top screen and answer the pointer. `touch`: editing shows the top bar.
    pub fn draw(&mut self, ui: &mut Ui, touch: bool) -> Outcome {
        let (w, h) = ui.screen();
        if !self.in_field() {
            ui.p.cover(Art::Background, Rect::new(0.0, 0.0, w, h), WHITE);
        }
        let editing_bar = touch && self.focus.is_some();
        // a tap anywhere but the bar ends the editing; the screen under it is not touchable
        if editing_bar {
            ui.enabled = false;
        }
        let rail = matches!(self.top(), Screen::Home | Screen::Edu | Screen::Games | Screen::Pets | Screen::Settings);
        self.left = if rail { RAIL_W } else { 0.0 };
        let out = match self.top().clone() {
            Screen::Loading => {
                self.draw_loading(ui);
                Outcome::None
            }
            Screen::Name => {
                self.draw_name(ui);
                Outcome::None
            }
            Screen::Home => {
                self.draw_home(ui);
                Outcome::None
            }
            Screen::Edu => self.draw_edu(ui),
            Screen::SoloTheme => self.draw_solo_theme(ui),
            Screen::Teacher => {
                self.draw_teacher(ui);
                Outcome::None
            }
            Screen::Student => {
                self.draw_student(ui);
                Outcome::None
            }
            Screen::Confirm { teacher } => {
                self.draw_confirm(ui, &teacher);
                Outcome::None
            }
            Screen::Games => self.draw_games(ui),
            Screen::Pets => {
                self.draw_pets(ui);
                Outcome::None
            }
            Screen::Settings => {
                self.draw_settings(ui);
                Outcome::None
            }
            Screen::Rooms => {
                self.draw_rooms(ui);
                Outcome::None
            }
            Screen::Create => {
                self.draw_create(ui);
                Outcome::None
            }
            Screen::Waiting => {
                self.draw_waiting(ui);
                Outcome::None
            }
            Screen::Entering => {
                self.draw_entering(ui);
                Outcome::None
            }
            Screen::InField => {
                self.draw_in_field(ui);
                Outcome::None
            }
        };
        if rail {
            self.draw_rail(ui);
        }
        ui.enabled = true;
        if editing_bar {
            if let Some(f) = self.focus {
                let shown = self.edit_mut(f).shown();
                let caret = (ui.time * 2.0).fract() < 0.5;
                let (bar, done) = ui.p.edit_bar(ui.t, w, h, &shown, f.placeholder(), caret);
                if ui.clicked(done) {
                    self.submit();
                } else if ui.ptr.released && !bar.contains(ui.ptr.pos.0, ui.ptr.pos.1) {
                    self.focus_on(None);
                } else if ui.clicked(bar) {
                    self.focus_on(Some(f));
                }
                self.edit_bar = Some((bar, done));
            }
        } else {
            self.edit_bar = None;
        }
        if let Some((msg, _)) = self.toast.clone() {
            draw_toast(ui, &msg);
        }
        out
    }

    /// The app clock while no menu screen runs (island play): toasts are stamped and expire on it.
    pub fn set_now(&mut self, now: f64) {
        self.now = now;
    }

    /// Only the notice (island play draws no menu screen; it expires like any other toast).
    pub fn draw_toast(&mut self, ui: &mut Ui) {
        if self.toast.as_ref().is_some_and(|t| self.now > t.1) {
            self.toast = None;
        }
        if let Some((msg, _)) = self.toast.clone() {
            draw_toast(ui, &msg);
        }
    }

    /// The chat button (the top-right strip): type a message.
    pub fn open_chat(&mut self) {
        self.focus_on(Some(Field::Chat));
    }

    /// Typing in the chat (its button shows pressed).
    pub fn chatting(&self) -> bool {
        self.focus == Some(Field::Chat)
    }

    /// A text field bound to `f`: tap to type.
    fn field(&mut self, ui: &mut Ui, f: Field, r: Rect) {
        let focused = self.focus == Some(f);
        let shown = self.edit_mut(f).shown();
        let caret = (ui.time * 2.0).fract() < 0.5;
        let shown = if f == Field::Password { "●".repeat(shown.chars().count()) } else { shown };
        ui.p.field(ui.t, r, &shown, f.placeholder(), focused, caret);
        if ui.clicked(r) {
            self.focus_on(Some(f));
        }
    }

    /// The top bar every screen shares (the web's hub bar): the web's bar frame over navy glass,
    /// a back pill, the screen's icon + title, and the live connection state on the right.
    fn header_with(&mut self, ui: &mut Ui, title: &str, icon: Option<Art>) {
        let (w, _) = ui.screen();
        let bar = Rect::new(self.left + M, 10.0, w - self.left - 2.0 * M, TOP_BAR);
        glass(ui, bar, false);
        let mut x = bar.x + 18.0;
        if self.left == 0.0 {
            if ui.button(Rect::new(bar.x + 8.0, bar.y + 7.0, 88.0, TOP_BAR - 14.0), "‹ 뒤로", ButtonStyle::Plain, true) {
                self.back();
            }
            x = bar.x + 112.0;
        }
        if let Some(icon) = icon {
            ui.p.image(icon, Rect::new(x, bar.y + 10.0, 32.0, 32.0), WHITE);
            x += 40.0;
        }
        let s = scale(ui);
        let title = ui.t.fit(title, 21.0 * s, (bar.w - (x - bar.x) - 190.0) * s);
        ui.text(&title, x, bar.y + (TOP_BAR - line_height(ui.t, 21.0, s)) / 2.0, 21.0, WHITE, Align::Left);
        self.status_chip(ui, Rect::new(bar.x + bar.w - 8.0 - 156.0, bar.y + 9.0, 156.0, TOP_BAR - 18.0));
    }

    fn status_chip(&self, ui: &mut Ui, r: Rect) {
        let (label, dot) = match &self.hub.state {
            HubState::Lobby | HubState::Room | HubState::Starting { .. } => ("서버 연결됨", GREEN_DOT),
            HubState::Connecting { .. } => ("연결하는 중…", GOLD),
            HubState::Offline { .. } => ("오프라인", RED_DOT),
            HubState::UpdateRequired => ("업데이트 필요", RED_DOT),
        };
        ui.p.rect(r.x, r.y, r.w, r.h, r.h / 2.0, [0x0d, 0x16, 0x2c, 0xb0]);
        ui.p.disc(r.x + 17.0, r.y + r.h / 2.0, 7.0, [dot[0], dot[1], dot[2], 0x55]);
        ui.p.disc(r.x + 17.0, r.y + r.h / 2.0, 4.5, dot);
        let size = 14.0;
        let ty = r.y + (r.h - line_height(ui.t, size, scale(ui))) / 2.0;
        ui.text(label, r.x + 31.0, ty, size, WHITE, Align::Left);
    }

    /// The bottom action bar: a hint on the left, the main action on the right. Returns the action
    /// rectangle (the caller draws its button there) — it never scrolls off a short phone screen.
    fn action_bar(&self, ui: &mut Ui, hint: &str, action_w: f32) -> Rect {
        let (w, h) = ui.screen();
        let bar = Rect::new(M, h - BOTTOM_BAR - 10.0, w - 2.0 * M, BOTTOM_BAR);
        glass(ui, bar, false);
        let s = scale(ui);
        let hint = ui.t.fit(hint, 15.0 * s, (bar.w - action_w - 40.0) * s);
        ui.text(&hint, bar.x + 22.0, bar.y + (BOTTOM_BAR - line_height(ui.t, 15.0, s)) / 2.0, 15.0, DIM_TEXT, Align::Left);
        Rect::new(bar.x + bar.w - 8.0 - action_w, bar.y + 7.0, action_w, BOTTOM_BAR - 14.0)
    }

    /// A choice card (the web's hub-entry button): white face, the card frame, a drop shadow.
    /// Wide cards put the picture on the left (42 %, like the web); tall ones on top.
    #[allow(clippy::too_many_arguments)]
    fn card(&mut self, ui: &mut Ui, r: Rect, art: Art, title: &str, sub: &str, cta: &str, accent: [u8; 4]) -> bool {
        let pressed = ui.pressing(r);
        let lift = if pressed { 3.0 } else { 0.0 };
        let r2 = Rect::new(r.x, r.y + lift, r.w, r.h);
        let face = white_card(ui, r2, pressed);
        let s = scale(ui);
        let wide = r.w > r.h * 1.45;
        let (pic, text) = if wide {
            let pw = face.w * 0.42;
            (Rect::new(face.x, face.y, pw, face.h), Rect::new(face.x + pw + 14.0, face.y + 4.0, face.w - pw - 18.0, face.h - 8.0))
        } else {
            let ph = (face.h * 0.5).min(face.w * 0.62);
            (Rect::new(face.x, face.y, face.w, ph), Rect::new(face.x + 6.0, face.y + ph + 8.0, face.w - 12.0, face.h - ph - 10.0))
        };
        // the picture on a soft shade (no line around it)
        ui.p.rect(pic.x - 1.0, pic.y + 2.0, pic.w + 2.0, pic.h, 12.0, [0x0a, 0x14, 0x32, 0x1c]);
        ui.p.cover(art, pic, WHITE);
        let title_size = if wide { 21.0 } else { 18.0 };
        let mut y = text.y;
        let title_fit = ui.t.fit(title, title_size * s, text.w * s);
        ui.text(&title_fit, text.x, y, title_size, CARD_TEXT, Align::Left);
        y += line_height(ui.t, title_size, s) + 2.0;
        let cta_h = 32.0;
        let room = text.y + text.h - cta_h - 6.0 - y;
        let lh = line_height(ui.t, 13.5, s);
        if room >= lh {
            let lines = ui.t.wrap(sub, 13.5 * s, text.w * s);
            for (i, l) in lines.iter().take((room / lh).floor() as usize).enumerate() {
                ui.text(l, text.x, y + i as f32 * lh, 13.5, CARD_MUTED, Align::Left);
            }
        }
        let cw = ui.t.width(cta, 15.0 * s) / s + 30.0;
        let pill = Rect::new(text.x, text.y + text.h - cta_h, cw, cta_h);
        ui.p.rect(pill.x, pill.y + 3.0, pill.w, pill.h, cta_h / 2.0, [0x00, 0x00, 0x00, 0x30]);
        ui.p.rect(pill.x, pill.y, pill.w, pill.h, cta_h / 2.0, accent);
        ui.text(cta, pill.x + pill.w / 2.0, pill.y + (cta_h - line_height(ui.t, 15.0, s)) / 2.0, 15.0, WHITE, Align::Center);
        ui.clicked(r)
    }

    fn draw_loading(&mut self, ui: &mut Ui) {
        let (w, h) = ui.screen();
        // the background art carries the logo; the progress sits on a glass pill under it
        let server = match &self.hub.state {
            HubState::Connecting { .. } => 0.3,
            _ => 1.0,
        };
        let frac = ((self.progress.art + self.progress.world + server) / 3.0).clamp(0.0, 1.0);
        let stage = if self.progress.art < 1.0 {
            "그림 준비하는 중…"
        } else if self.progress.world < 1.0 {
            "블록 섬 만드는 중…"
        } else {
            match &self.hub.state {
                HubState::Connecting { .. } => "서버에 연결하는 중…",
                HubState::Offline { .. } => "서버에 연결하지 못했어요 · 혼자 하기는 할 수 있어요",
                HubState::UpdateRequired => "새 버전이 나왔어요 · 앱을 업데이트해 주세요",
                _ => "준비 완료!",
            }
        };
        let pw = (w * 0.56).clamp(300.0, 560.0);
        let pill = Rect::new((w - pw) / 2.0, h * 0.68, pw, 78.0);
        glass(ui, pill, false);
        let bar = Rect::new(pill.x + 26.0, pill.y + 18.0, pill.w - 52.0, 16.0);
        ui.p.rect(bar.x, bar.y, bar.w, bar.h, 8.0, [0x0b, 0x12, 0x24, 0xff]);
        ui.p.rect(bar.x, bar.y, (bar.w * frac).max(bar.h), bar.h, 8.0, GOLD);
        ui.p.rect(bar.x + 4.0, bar.y + 3.0, ((bar.w * frac) - 8.0).max(0.0), 4.0, 2.0, [0xff, 0xff, 0xff, 0x70]);
        let s = scale(ui);
        let stage = ui.t.fit(stage, 15.0 * s, (pill.w - 120.0) * s);
        ui.text(&stage, bar.x, bar.y + 26.0, 15.0, DIM_TEXT, Align::Left);
        ui.text(&format!("{:.0}%", frac * 100.0), bar.x + bar.w, bar.y + 26.0, 15.0, WHITE, Align::Right);
        let elapsed = self.now - self.started;
        let server_settled = !matches!(self.hub.state, HubState::Connecting { .. }) || elapsed > 8.0;
        if self.progress.art >= 1.0 && self.progress.world >= 1.0 && server_settled && elapsed > 0.8 {
            self.replace(if self.profile.name.is_empty() { Screen::Name } else { Screen::Home });
        }
    }

    fn draw_name(&mut self, ui: &mut Ui) {
        let (w, h) = ui.screen();
        let first = self.profile.name.is_empty();
        scrim(ui, 0.8);
        let top = if first { 20.0 } else { CONTENT_TOP };
        if !first {
            self.header_with(ui, "내 이름 바꾸기", Some(Art::NavFriends));
        }
        let cw = (w - 2.0 * M).min(560.0);
        let card = Rect::new((w - cw) / 2.0, top + ((h - top - 220.0) / 2.0).max(0.0), cw, 220.0f32.min(h - top - M));
        let face = white_card(ui, card, false);
        ui.text(if first { "반가워요! 이름을 알려 주세요" } else { "새 이름을 써 주세요" }, face.x + 6.0, face.y, 22.0, CARD_TEXT, Align::Left);
        ui.text("친구와 선생님에게 이 이름이 보여요 (1~16자)", face.x + 6.0, face.y + 34.0, 14.0, CARD_MUTED, Align::Left);
        self.field(ui, Field::Name, Rect::new(face.x + 6.0, face.y + 64.0, face.w - 12.0, 50.0));
        if ui.button(Rect::new(face.x + face.w - 160.0, face.y + face.h - 50.0, 154.0, 48.0), "확인", ButtonStyle::Primary, true) {
            self.save_name();
        }
    }

    fn draw_home(&mut self, ui: &mut Ui) {
        let (w, h) = ui.screen();
        scrim(ui, 0.35);
        // the background art carries the big logo at its top: the cards stay below it, beside the rail
        let (left, cw_all) = (self.left, w - self.left);
        let gap = 18.0;
        let cw = ((cw_all - 2.0 * M - gap) / 2.0).min(440.0);
        let y = (h * 0.40).min(h - 24.0 - 150.0).max(CONTENT_TOP - 20.0);
        let ch = (h - y - 24.0).clamp(150.0, 240.0);
        let x0 = left + (cw_all - 2.0 * cw - gap) / 2.0;
        if self.card(ui, Rect::new(x0, y, cw, ch), Art::CardEducation, "교육 모드 · 교실", "끝없는 들판에서 자유롭게 만들고, 같은 교실에서 함께 지어요", "시작하기 ›", [0x2f, 0x9e, 0x44, 0xff]) {
            self.rail_go(Screen::Edu);
        }
        if self.card(ui, Rect::new(x0 + cw + gap, y, cw, ch), Art::CardGames, "함께 놀기 · 온라인", "방을 만들거나 열린 방에 들어가 친구와 같은 들판에서 놀아요", "골라 보기 ›", [0x1f, 0x6f, 0xd8, 0xff]) {
            self.rail_go(Screen::Games);
        }
    }

    /// A rail destination: the rail's screens sit one level above home, so back always lands there.
    fn rail_go(&mut self, s: Screen) {
        self.stack.retain(|x| !matches!(x, Screen::Edu | Screen::Games | Screen::Pets | Screen::Settings));
        if s != Screen::Home {
            self.stack.push(s);
        }
    }

    /// The navigation rail: brand mark, the destinations (icon + label, the active one lit with a
    /// yellow bar, live counts as badges, unfinished ones answering "곧 열려요"), and at its foot
    /// who you are (tap to rename) with the connection dot.
    fn draw_rail(&mut self, ui: &mut Ui) {
        let (_, h) = ui.screen();
        let s = scale(ui);
        // the column: deep navy glass with a soft lit edge and a shadow onto the scene
        ui.p.rect(RAIL_W - 2.0, 0.0, 14.0, h, 0.0, [0x05, 0x0f, 0x28, 0x30]);
        ui.p.rect(0.0, 0.0, RAIL_W, h, 0.0, [0x10, 0x1c, 0x38, 0xf0]);
        ui.p.rect(0.0, 0.0, RAIL_W, h * 0.5, 0.0, [0x2b, 0x3f, 0x7a, 0x38]);
        ui.p.rect(RAIL_W - 1.5, 0.0, 1.5, h, 0.0, [0xff, 0xff, 0xff, 0x22]);
        // the brand mark
        // the brand mark, capped in height so a short phone keeps room for every destination
        let mut logo_bottom = 8.0;
        if let Some((lw, lh)) = ui.p.art_size(Art::Logo) {
            let bh = (h * 0.11).clamp(34.0, 52.0);
            let bw = (bh * lw / lh).min(RAIL_W - 12.0);
            let bh = bw * lh / lw;
            ui.p.image(Art::Logo, Rect::new((RAIL_W - bw) / 2.0, 8.0, bw, bh), WHITE);
            logo_bottom = 8.0 + bh;
        }
        let online = matches!(self.hub.state, HubState::Lobby | HubState::Room);
        let rooms = self.hub.rooms.iter().filter(|r| r.game == game::BUILD).count();
        let top = self.top().clone();
        let items: [(Art, &str, Option<Screen>, usize); 6] = [
            (Art::NavHome, "홈", Some(Screen::Home), 0),
            (Art::NavEdu, "교육", Some(Screen::Edu), 0),
            (Art::NavPlay, "함께 놀기", Some(Screen::Games), if online { rooms } else { 0 }),
            (Art::GlyphPaw, "펫", Some(Screen::Pets), 0),
            (Art::NavFriends, "친구", None, 0),
            (Art::NavSettings, "설정", Some(Screen::Settings), 0),
        ];
        let foot = 62.0;
        let y0 = logo_bottom + 6.0;
        let ih = ((h - y0 - foot - 6.0) / items.len() as f32).min(64.0);
        for (i, (icon, label, dest, badge)) in items.into_iter().enumerate() {
            let tile = Rect::new(8.0, y0 + i as f32 * ih + 2.0, RAIL_W - 16.0, ih - 4.0);
            let active = dest.as_ref() == Some(&top);
            let pressed = ui.pressing(tile);
            if active || pressed {
                ui.p.rect(tile.x, tile.y, tile.w, tile.h, 14.0, [0xff, 0xff, 0xff, if active { 0x24 } else { 0x14 }]);
            }
            if active {
                ui.p.rect(0.0, tile.y + tile.h * 0.22, 4.0, tile.h * 0.56, 2.0, RAIL_ACCENT);
            }
            let isz = (ih * 0.5).clamp(22.0, 32.0);
            let (cx, iy) = (tile.x + tile.w / 2.0, tile.y + (tile.h - isz - 15.0) / 2.0);
            let fade = if dest.is_none() { 0x90 } else { 0xff };
            ui.p.image(icon, Rect::new(cx - isz / 2.0, iy, isz, isz), [0xff, 0xff, 0xff, fade]);
            if badge > 0 {
                let t = if badge > 99 { "99+".to_owned() } else { badge.to_string() };
                let bw = (ui.t.width(&t, 10.5 * s) / s + 9.0).max(17.0);
                let (bx, by) = (cx + isz * 0.32, iy - 3.0);
                ui.p.rect(bx, by, bw, 17.0, 8.5, RAIL_BADGE);
                ui.text(&t, bx + bw / 2.0, by + (17.0 - line_height(ui.t, 10.5, s)) / 2.0, 10.5, WHITE, Align::Center);
            }
            let color = if active { WHITE } else { DIM_TEXT };
            let fit = ui.t.fit(label, 11.5 * s, (tile.w - 2.0) * s);
            ui.text(&fit, cx, iy + isz + 2.0, 11.5, color, Align::Center);
            if ui.clicked(tile) {
                match dest {
                    Some(d) if d != top => self.rail_go(d),
                    Some(_) => {}
                    None => self.toast("곧 열려요! 조금만 기다려 주세요."),
                }
            }
        }
        // who you are, at the foot: an avatar disc with the name's first letter and the server dot
        let me = Rect::new(8.0, h - foot, RAIL_W - 16.0, foot - 8.0);
        if ui.pressing(me) {
            ui.p.rect(me.x, me.y, me.w, me.h, 14.0, [0xff, 0xff, 0xff, 0x14]);
        }
        let (ax, ay) = (me.x + me.w / 2.0, me.y + 18.0);
        ui.p.disc(ax, ay, 17.0, [0x3d, 0x8b, 0xf0, 0xff]);
        ui.p.disc(ax, ay - 2.0, 15.0, [0x5c, 0xa0, 0xf5, 0xff]);
        let initial: String = self.profile.name.chars().take(1).collect();
        ui.text(&initial, ax, ay - line_height(ui.t, 16.0, s) / 2.0 - 1.0, 16.0, WHITE, Align::Center);
        let dot = match &self.hub.state {
            HubState::Lobby | HubState::Room | HubState::Starting { .. } => GREEN_DOT,
            HubState::Connecting { .. } => GOLD,
            _ => RED_DOT,
        };
        ui.p.disc(ax + 12.0, ay + 12.0, 6.0, [0x10, 0x1c, 0x38, 0xff]);
        ui.p.disc(ax + 12.0, ay + 12.0, 4.0, dot);
        let name = ui.t.fit(&self.profile.name, 11.5 * s, (me.w - 2.0) * s);
        ui.text(&name, ax, ay + 19.0, 11.5, WHITE, Align::Center);
        if ui.clicked(me) {
            let n = self.profile.name.clone();
            self.edit_mut(Field::Name).set(&n);
            self.go(Screen::Name);
        }
    }

    /// The settings: one white card of labelled rows (the web's settings card, the ones the app has).
    /// Every change is saved at once and applied live (the renderer, the look, the sound).
    fn draw_settings(&mut self, ui: &mut Ui) {
        let (w, h) = ui.screen();
        scrim(ui, 0.6);
        self.header_with(ui, "설정", Some(Art::NavSettings));
        let s = scale(ui);
        let cw = (w - self.left - 2.0 * M).min(720.0);
        let card = Rect::new(self.left + (w - self.left - cw) / 2.0, CONTENT_TOP, cw, (h - CONTENT_TOP - M).min(330.0));
        let face = white_card(ui, card, false);
        let label_w = (face.w * 0.3).clamp(120.0, 200.0);
        let (lx, cx, ctl_w) = (face.x + 6.0, face.x + label_w, face.w - label_w - 6.0);
        let row_h = (face.h / 5.0).min(58.0);
        let mut st = self.profile.settings.clone();
        let row = |i: usize| face.y + i as f32 * row_h;
        let label = |ui: &mut Ui, i: usize, title: &str, hint: &str| {
            let y = row(i);
            ui.text(title, lx, y + 6.0, 16.0, CARD_TEXT, Align::Left);
            ui.text(hint, lx, y + 6.0 + line_height(ui.t, 16.0, s), 12.0, CARD_MUTED, Align::Left);
        };
        // 그래픽: a segmented choice
        label(ui, 0, "그래픽", "자동은 기기에 맞춰 조절해요");
        let opts = [("auto", "자동"), ("low", "낮음"), ("medium", "보통"), ("high", "높음")];
        let seg = Rect::new(cx, row(0) + 8.0, ctl_w, row_h - 16.0);
        ui.p.rect(seg.x, seg.y, seg.w, seg.h, seg.h / 2.0, [0xe9, 0xee, 0xf6, 0xff]);
        let sw = seg.w / opts.len() as f32;
        for (i, (key, name)) in opts.iter().enumerate() {
            let r = Rect::new(seg.x + i as f32 * sw, seg.y, sw, seg.h);
            let on = st.graphics == *key;
            if on {
                ui.p.rect(r.x + 3.0, r.y + 5.0, r.w - 6.0, r.h - 6.0, (r.h - 6.0) / 2.0, [0x1f, 0x6f, 0xd8, 0x40]);
                ui.p.rect(r.x + 3.0, r.y + 3.0, r.w - 6.0, r.h - 6.0, (r.h - 6.0) / 2.0, [0x1f, 0x6f, 0xd8, 0xff]);
            }
            ui.text(name, r.x + r.w / 2.0, r.y + (r.h - line_height(ui.t, 15.0, s)) / 2.0, 15.0, if on { WHITE } else { CARD_TEXT }, Align::Center);
            if ui.clicked(r) {
                st.graphics = (*key).to_owned();
            }
        }
        // 시야 감도 / 효과음: sliders (drag or tap along the track)
        let (lo, hi) = crate::profile::SENSITIVITY_RANGE;
        label(ui, 1, "시야 감도", "화면을 돌리는 빠르기");
        if let Some(v) = slider(ui, Rect::new(cx, row(1), ctl_w, row_h), ((st.sensitivity - lo) / (hi - lo)) as f32, &format!("{:.1}×", st.sensitivity)) {
            st.sensitivity = ((lo + v as f64 * (hi - lo)) * 10.0).round() / 10.0;
        }
        label(ui, 2, "효과음", "블록, 발소리, 펫 소리");
        if let Some(v) = slider(ui, Rect::new(cx, row(2), ctl_w, row_h), st.sfx as f32, &format!("{:.0}%", st.sfx * 100.0)) {
            st.sfx = (v as f64 * 20.0).round() / 20.0;
        }
        // 상하 반전: a toggle
        label(ui, 3, "상하 반전", "위로 끌면 아래를 봐요");
        let tg = Rect::new(cx, row(3) + (row_h - 30.0) / 2.0, 56.0, 30.0);
        ui.p.rect(tg.x, tg.y, tg.w, tg.h, 15.0, if st.invert_y { [0x2f, 0x9e, 0x44, 0xff] } else { [0xc9, 0xd1, 0xde, 0xff] });
        let kx = if st.invert_y { tg.x + tg.w - 15.0 } else { tg.x + 15.0 };
        ui.p.disc(kx, tg.y + 16.5, 12.0, [0x00, 0x00, 0x00, 0x22]);
        ui.p.disc(kx, tg.y + 15.0, 12.0, WHITE);
        if ui.clicked(Rect::new(tg.x - 6.0, row(3), ctl_w.min(140.0), row_h)) {
            st.invert_y = !st.invert_y;
        }
        // 이름
        label(ui, 4, "내 이름", "친구와 선생님에게 보여요");
        let name = self.profile.name.clone();
        let nb = Rect::new(cx, row(4) + 8.0, ctl_w.min(320.0), row_h - 16.0);
        if ui.button(nb, &format!("{name}  ·  바꾸기 ›"), ButtonStyle::Plain, true) {
            self.edit_mut(Field::Name).set(&name);
            self.go(Screen::Name);
        }
        // separators between rows
        for i in 1..5 {
            ui.p.rect(face.x + 6.0, row(i) - 0.5, face.w - 12.0, 1.0, 0.0, [0x1f, 0x2a, 0x44, 0x18]);
        }
        if st != self.profile.settings {
            self.profile.settings = st.clamped();
            self.profile.save();
        }
    }

    /// The pet collection: the five animals as cards (head, name, character line); the adopted one
    /// is marked, a tap adopts (saved, and the game's pet follows it).
    fn draw_pets(&mut self, ui: &mut Ui) {
        let (w, h) = ui.screen();
        scrim(ui, 0.6);
        self.header_with(ui, "펫 · 함께 다닐 친구를 골라요", Some(Art::GlyphPaw));
        let Some(d) = crate::pet::data() else { return };
        let s = scale(ui);
        let (left, cw_all) = (self.left + M, w - self.left - 2.0 * M);
        let n = d.order.len() as f32;
        let gap = 12.0;
        let cw = ((cw_all - gap * (n - 1.0)) / n).min(190.0);
        let ch = (h - CONTENT_TOP - M).min(250.0);
        let x0 = left + (cw_all - (cw * n + gap * (n - 1.0))) / 2.0;
        let heads = [Art::PetDog, Art::PetCat, Art::PetElephant, Art::PetGiraffe, Art::PetPanda];
        let mut adopt = None;
        for (i, key) in d.order.iter().enumerate() {
            let Some(sp) = d.species.get(key) else { continue };
            let r = Rect::new(x0 + i as f32 * (cw + gap), CONTENT_TOP, cw, ch);
            let mine = *key == self.profile.pet;
            let pressed = ui.pressing(r);
            let face = white_card(ui, Rect::new(r.x, r.y + if pressed { 3.0 } else { 0.0 }, r.w, r.h), pressed || mine);
            // the head on a soft tinted disc
            let d_r = (face.w * 0.36).min(ch * 0.24);
            let (cx, cy) = (face.x + face.w / 2.0, face.y + d_r + 6.0);
            ui.p.disc(cx, cy, d_r, if mine { [0xff, 0xe7, 0x8a, 0xff] } else { [0xee, 0xf2, 0xfa, 0xff] });
            if let Some(head) = heads.get(i) {
                if let Some((iw, ih)) = ui.p.art_size(*head) {
                    let k = d_r * 1.6 / iw.max(ih);
                    ui.p.image(*head, Rect::new(cx - iw * k / 2.0, cy - ih * k / 2.0, iw * k, ih * k), WHITE);
                }
            }
            let mut y = cy + d_r + 10.0;
            let name = ui.t.fit(&sp.name, 16.0 * s, face.w * s);
            ui.text(&name, cx, y, 16.0, CARD_TEXT, Align::Center);
            y += line_height(ui.t, 16.0, s) + 2.0;
            let lh = line_height(ui.t, 12.5, s);
            for (k, l) in ui.t.wrap(&sp.trait_line, 12.5 * s, face.w * s).iter().take(2).enumerate() {
                ui.text(l, cx, y + k as f32 * lh, 12.5, CARD_MUTED, Align::Center);
            }
            let pill_h = 28.0;
            let label = if mine { "함께 있어요" } else { "데려가기" };
            let pw = ui.t.width(label, 13.5 * s) / s + 26.0;
            let pill = Rect::new(cx - pw / 2.0, face.y + face.h - pill_h, pw, pill_h);
            ui.p.rect(pill.x, pill.y, pill.w, pill.h, pill_h / 2.0, if mine { [0x2f, 0x9e, 0x44, 0xff] } else { [0x1f, 0x6f, 0xd8, 0xff] });
            ui.text(label, cx, pill.y + (pill_h - line_height(ui.t, 13.5, s)) / 2.0, 13.5, WHITE, Align::Center);
            if ui.clicked(r) && !mine {
                adopt = Some((key.clone(), sp.name.clone()));
            }
        }
        if let Some((key, name)) = adopt {
            self.profile.pet = key;
            self.profile.save();
            self.toast(format!("{name}{} 데려왔어요! 게임에서 함께 다녀요", crate::pet::object_particle(&name)));
        }
    }

    /// Three choice cards filling the content area under the top bar.
    fn three_cards(&mut self, ui: &mut Ui, bottom: f32, cards: [(Art, &str, &str, &str, [u8; 4]); 3]) -> Option<usize> {
        let (w, _) = ui.screen();
        let (left, w) = (self.left, w - self.left);
        let gap = 16.0;
        let cw = ((w - 2.0 * M - 2.0 * gap) / 3.0).min(300.0);
        let ch = (bottom - CONTENT_TOP).clamp(150.0, 320.0);
        let x0 = left + (w - 3.0 * cw - 2.0 * gap) / 2.0;
        let mut hit = None;
        for (i, (art, title, sub, cta, accent)) in cards.into_iter().enumerate() {
            if self.card(ui, Rect::new(x0 + i as f32 * (cw + gap), CONTENT_TOP, cw, ch), art, title, sub, cta, accent) {
                hit = Some(i);
            }
        }
        hit
    }

    fn draw_edu(&mut self, ui: &mut Ui) -> Outcome {
        let (_, h) = ui.screen();
        scrim(ui, 0.6);
        self.header_with(ui, "교육 모드 · 어떻게 시작할까요?", Some(Art::NavEdu));
        match self.three_cards(
            ui,
            h - M - 8.0,
            [
                (Art::CardTeacher, "선생님 · 반 만들기", "반 이름을 정해서 열면 학생들이 들어와요", "반 열기 ›", [0x2f, 0x9e, 0x44, 0xff]),
                (Art::CardStudent, "학생 · 반 참여하기", "반 이름과 내 이름을 입력해요", "참여하기 ›", [0x1f, 0x6f, 0xd8, 0xff]),
                (Art::CardSolo, "혼자 하기", "블록 섬에서 혼자 만들고 실험해요", "시작하기 ›", [0xe8, 0x6a, 0x1a, 0xff]),
            ],
        ) {
            Some(0) => self.go(Screen::Teacher),
            Some(1) => self.go(Screen::Student),
            Some(2) => self.go(Screen::SoloTheme),
            _ => {}
        }
        Outcome::None
    }
    fn draw_solo_theme(&mut self,ui:&mut Ui)->Outcome{
        let(w,h)=ui.screen();scrim(ui,0.6);self.header_with(ui,"혼자 하기 · 체험을 골라요",Some(Art::NavEdu));
        let cw=(w-40.).min(620.);let x=(w-cw)/2.;let y=(h/2.-20.).max(CONTENT_TOP);
        if ui.button(Rect::new(x,y,cw,56.),"블록 섬 · 만들고 실험하기",ButtonStyle::Primary,true){return Outcome::PlaySolo;}
        if ui.button(Rect::new(x,y+72.,cw,56.),"화재 체험 · 학교에서 대피 훈련",ButtonStyle::Go,true){return Outcome::PlayFire;}
        Outcome::None
    }

    /// A form on a white card between the top bar and the action bar, laid out as label | control
    /// rows. Returns (label x, control x, control width, first row y).
    fn form_card(&self, ui: &mut Ui, rows: usize) -> (f32, f32, f32, f32) {
        let (w, h) = ui.screen();
        let cw = (w - 2.0 * M).min(640.0);
        let avail = h - CONTENT_TOP - BOTTOM_BAR - 30.0;
        let ch = (rows as f32 * 58.0 + 30.0).min(avail);
        let card = Rect::new((w - cw) / 2.0, CONTENT_TOP + ((avail - ch) / 2.0).max(0.0), cw, ch);
        let face = white_card(ui, card, false);
        let label_w = 112.0;
        (face.x + 8.0, face.x + 8.0 + label_w, face.w - label_w - 16.0, face.y + 2.0)
    }

    fn form_label(ui: &mut Ui, text: &str, x: f32, row_y: f32) {
        let s = scale(ui);
        ui.text(text, x, row_y + (48.0 - line_height(ui.t, 16.0, s)) / 2.0, 16.0, CARD_TEXT, Align::Left);
    }

    fn draw_teacher(&mut self, ui: &mut Ui) {
        scrim(ui, 0.7);
        self.header_with(ui, "선생님 · 반 만들기", Some(Art::NavEdu));
        let (lx, cx, cw, y) = self.form_card(ui, 4);
        Self::form_label(ui, "반 이름", lx, y);
        self.field(ui, Field::ClassName, Rect::new(cx, y, cw, 48.0));
        Self::form_label(ui, "비밀번호", lx, y + 58.0);
        self.field(ui, Field::Password, Rect::new(cx, y + 58.0, cw, 48.0));
        Self::form_label(ui, "선생님", lx, y + 116.0);
        let me = self.profile.name.clone();
        let s = scale(ui);
        ui.text(&me, cx + 4.0, y + 116.0 + (48.0 - line_height(ui.t, 18.0, s)) / 2.0, 18.0, CARD_TEXT, Align::Left);
        Self::form_label(ui,"새 반의 체험",lx,y+174.);
        if ui.button(Rect::new(cx,y+174.,cw/2.-4.,42.),"블록 만들기",if self.class_theme=="craft"{ButtonStyle::Primary}else{ButtonStyle::Plain},true){self.class_theme="craft".into();}
        if ui.button(Rect::new(cx+cw/2.+4.,y+174.,cw/2.-4.,42.),"화재 체험",if self.class_theme=="fire"{ButtonStyle::Primary}else{ButtonStyle::Plain},true){self.class_theme="fire".into();}
        let action = self.action_bar(ui, "다른 기기에서 반을 다시 열 때 비밀번호가 필요해요", 190.0);
        if ui.button(action, "반 열기 →", ButtonStyle::Go, true) {
            let room = self.value(Field::ClassName);
            let pass = self.value(Field::Password);
            let has_key = self.profile.class_seat(&room, true).is_some();
            if !profile::valid_class_name(&room) {
                self.toast("반 이름을 1~20자로 써 주세요.");
            } else if !has_key && pass.chars().count() < 4 {
                self.toast("새 반은 비밀번호가 4자 이상이어야 해요.");
            } else {
                self.profile.last_class = room.clone();
                let name = self.profile.name.clone();
                self.enter_class(room.clone(), room, &name, true, (!pass.is_empty()).then_some(pass), false);
            }
        }
    }

    fn draw_student(&mut self, ui: &mut Ui) {
        scrim(ui, 0.7);
        self.header_with(ui, "학생 · 반 참여하기", Some(Art::NavFriends));
        let (lx, cx, cw, y) = self.form_card(ui, 2);
        Self::form_label(ui, "반 이름", lx, y);
        self.field(ui, Field::ClassName, Rect::new(cx, y, cw, 48.0));
        Self::form_label(ui, "내 이름", lx, y + 58.0);
        let me = self.profile.name.clone();
        let s = scale(ui);
        ui.text(&me, cx + 4.0, y + 58.0 + (48.0 - line_height(ui.t, 18.0, s)) / 2.0, 18.0, CARD_TEXT, Align::Left);
        let busy = self.peek.is_some();
        let action = self.action_bar(ui, "선생님이 알려 준 반 이름을 써요", 170.0);
        if ui.button(action, if busy { "확인 중…" } else { "다음 →" }, ButtonStyle::Primary, !busy) {
            let room = self.value(Field::ClassName);
            if !profile::valid_class_name(&room) {
                self.toast("반 이름을 1~20자로 써 주세요.");
            } else {
                let url = format!("{}/ws?mode=class&room={}", self.server, profile::url_encode(&room));
                self.peek = Some(Link::open(&url, Some(encode(&ClassClient::Peek { v: CLASS_PROTOCOL_VERSION, room })), LinkOptions::default()));
            }
        }
    }

    fn draw_confirm(&mut self, ui: &mut Ui, teacher: &str) {
        let (w, h) = ui.screen();
        scrim(ui, 0.7);
        self.header_with(ui, "이 반이 맞나요?", Some(Art::NavEdu));
        let cw = (w - 2.0 * M).min(520.0);
        let ch = 200.0f32.min(h - CONTENT_TOP - M);
        let card = Rect::new((w - cw) / 2.0, CONTENT_TOP + ((h - CONTENT_TOP - M - ch) / 2.0).max(0.0), cw, ch);
        let face = white_card(ui, card, false);
        let room = self.value(Field::ClassName);
        ui.text(&room, face.x + face.w / 2.0, face.y + 4.0, 28.0, CARD_TEXT, Align::Center);
        ui.text(&format!("{teacher} 선생님의 반이에요"), face.x + face.w / 2.0, face.y + 50.0, 17.0, CARD_MUTED, Align::Center);
        let bw = ((face.w - 16.0) / 2.0).min(170.0);
        let by = face.y + face.h - 50.0;
        if ui.button(Rect::new(face.x + face.w / 2.0 - bw - 8.0, by, bw, 48.0), "다시 입력", ButtonStyle::Plain, true) {
            self.stack.pop();
        }
        if ui.button(Rect::new(face.x + face.w / 2.0 + 8.0, by, bw, 48.0), "들어가기 →", ButtonStyle::Go, true) {
            self.profile.last_class = room.clone();
            let name = self.profile.name.clone();
            self.stack.pop();
            self.enter_class(room.clone(), room, &name, false, None, false);
        }
    }

    fn draw_games(&mut self, ui: &mut Ui) -> Outcome {
        let (w, h) = ui.screen();
        scrim(ui, 0.6);
        self.header_with(ui, "함께 놀기 · 친구와 같은 들판에서", Some(Art::NavPlay));
        let online = matches!(self.hub.state, HubState::Lobby | HubState::Room);
        // the web's big yellow start button: quick join, centred at the bottom
        let cw = w - self.left;
        let sw = (cw * 0.5).clamp(280.0, 460.0);
        let start = Rect::new(self.left + (cw - sw) / 2.0, h - 82.0, sw, 66.0);
        let pressed = ui.pressing(start);
        if !ui.p.start_button(start, pressed) {
            ui.p.button(ui.t, start, "", ButtonStyle::Primary, pressed, true);
        }
        let s = scale(ui);
        let dy = if pressed { 3.0 } else { 0.0 };
        ui.text("▶ 빠른 입장", start.x + start.w / 2.0, start.y + (start.h - line_height(ui.t, 24.0, s)) / 2.0 - 3.0 + dy, 24.0, INK, Align::Center);
        if ui.clicked(start) {
            if online {
                self.hub.send(PartyClient::Quick { game: Some(game::BUILD.into()) });
            } else {
                self.toast("서버에 연결되면 할 수 있어요.");
            }
        }
        let room_count = self.hub.rooms.iter().filter(|r| r.game == game::BUILD).count();
        let list_sub = if online { format!("지금 열린 방 {room_count}개 · 코드로도 들어가요") } else { "서버에 연결하는 중이에요".to_owned() };
        match self.three_cards(
            ui,
            start.y - 18.0,
            [
                (Art::CardTeacher, "방 만들기", "내 방을 열고 친구를 불러요", "만들기 ›", [0xe8, 0x9a, 0x0c, 0xff]),
                (Art::CardStudent, "방 목록", &list_sub, "둘러보기 ›", [0x1f, 0x6f, 0xd8, 0xff]),
                (Art::CardCraft, "혼자 하기", "Craft Island · 블록 섬을 탐험해요", "시작하기 ›", [0x2f, 0x9e, 0x44, 0xff]),
            ],
        ) {
            Some(0) if online => {
                let title = format!("{}의 방", self.profile.name);
                self.edit_mut(Field::RoomTitle).set(&title);
                self.go(Screen::Create);
            }
            Some(0) => self.toast("서버에 연결되면 할 수 있어요."),
            Some(1) => {
                self.hub.list();
                self.go(Screen::Rooms);
            }
            Some(2) => return Outcome::PlaySolo,
            _ => {}
        }
        Outcome::None
    }

    /// A small rounded label (state, game, count) on a row.
    fn pill(ui: &mut Ui, right: f32, y: f32, text: &str, bg: [u8; 4], fg: [u8; 4]) -> f32 {
        let s = scale(ui);
        let pw = ui.t.width(text, 13.0 * s) / s + 20.0;
        ui.p.rect(right - pw, y, pw, 24.0, 12.0, bg);
        ui.text(text, right - pw / 2.0, y + (24.0 - line_height(ui.t, 13.0, s)) / 2.0, 13.0, fg, Align::Center);
        right - pw - 6.0
    }

    fn draw_rooms(&mut self, ui: &mut Ui) {
        let (w, h) = ui.screen();
        scrim(ui, 0.6);
        self.header_with(ui, "방 목록", Some(Art::NavFriends));
        let panel = Rect::new(M + 6.0, CONTENT_TOP + 4.0, w - 2.0 * M - 12.0, h - CONTENT_TOP - M - 14.0);
        glass(ui, panel, false);
        let inner = Rect::new(panel.x + 16.0, panel.y + 12.0, panel.w - 32.0, panel.h - 24.0);
        let bw = 136.0;
        self.field(ui, Field::Code, Rect::new(inner.x, inner.y, inner.w - bw - 10.0, 44.0));
        if ui.button(Rect::new(inner.x + inner.w - bw, inner.y, bw, 44.0), "코드로 입장", ButtonStyle::Primary, true) {
            self.join_code();
        }
        let list = Rect::new(inner.x, inner.y + 56.0, inner.w, inner.h - 56.0);
        let rooms = self.hub.rooms.clone();
        if rooms.is_empty() {
            let msg = if matches!(self.hub.state, HubState::Lobby | HubState::Room) { "아직 열린 방이 없어요. 방 만들기로 첫 방을 열어 보세요!" } else { "서버에 연결하는 중이에요…" };
            ui.p.image(Art::IconLock, Rect::new(list.x + list.w / 2.0 - 20.0, list.y + list.h / 2.0 - 44.0, 40.0, 40.0), WHITE);
            ui.text(msg, list.x + list.w / 2.0, list.y + list.h / 2.0 + 4.0, 15.0, DIM_TEXT, Align::Center);
            return;
        }
        let row_h = 58.0;
        let content = rooms.len() as f32 * (row_h + 8.0);
        if ui.enabled && ui.ptr.down && list.contains(ui.ptr.press_at.0, ui.ptr.press_at.1) {
            self.scroll -= ui.ptr.dy;
        }
        self.scroll = self.scroll.clamp(0.0, (content - list.h).max(0.0));
        let s = scale(ui);
        for (i, room) in rooms.iter().enumerate() {
            let y = list.y + i as f32 * (row_h + 8.0) - self.scroll;
            if y < list.y - 1.0 || y + row_h > list.y + list.h + 1.0 {
                continue; // no clipping in the overlay: rows only show whole
            }
            let r = Rect::new(list.x, y, list.w, row_h);
            let playable = room.game == game::BUILD;
            let full = room.players >= room.max;
            let pressed = ui.pressing(r) && playable && !full;
            let dy = if pressed { 2.0 } else { 0.0 };
            ui.p.rect(r.x, r.y + 3.0, r.w, r.h, 14.0, [0x05, 0x0f, 0x28, 0x50]);
            ui.p.rect(r.x, r.y + dy, r.w, r.h, 14.0, if playable { [0xff, 0xff, 0xff, 0xff] } else { [0xd7, 0xdb, 0xe4, 0xff] });
            ui.p.rect(r.x, r.y + dy, 6.0, r.h, 3.0, if room.state == "playing" { GREEN_DOT } else { GOLD });
            let title = ui.t.fit(&room.title, 17.0 * s, (r.w * 0.45) * s);
            ui.text(&title, r.x + 20.0, r.y + dy + 8.0, 17.0, CARD_TEXT, Align::Left);
            ui.text(&format!("방장 {}", room.host), r.x + 20.0, r.y + dy + 33.0, 13.0, CARD_MUTED, Align::Left);
            let py = r.y + dy + (row_h - 24.0) / 2.0;
            let mut right = r.x + r.w - 14.0;
            right = Self::pill(ui, right, py, &format!("{}/{}명", room.players, room.max), [0x1f, 0x2a, 0x44, 0xff], WHITE);
            right = Self::pill(ui, right, py, if playable { "함께 짓기" } else { "웹 전용" }, [0xe6, 0xec, 0xf6, 0xff], CARD_TEXT);
            let (state, bg) = if room.state == "playing" { ("게임 중", [0xd9, 0xf5, 0xdd, 0xff]) } else { ("대기 중", [0xff, 0xf1, 0xbf, 0xff]) };
            Self::pill(ui, right, py, state, bg, CARD_TEXT);
            if ui.clicked(r) && list.contains(ui.ptr.pos.0, ui.ptr.pos.1) {
                if !playable {
                    self.toast("이 게임은 아직 웹(craftyap.com)에서만 할 수 있어요.");
                } else if full {
                    self.toast("방이 꽉 찼어요.");
                } else {
                    self.hub.send(PartyClient::Join { code: room.code.clone() });
                }
            }
        }
    }

    fn draw_create(&mut self, ui: &mut Ui) {
        scrim(ui, 0.7);
        self.header_with(ui, "방 만들기", Some(Art::NavHome));
        let (lx, cx, cw, y) = self.form_card(ui, 4);
        let s = scale(ui);
        Self::form_label(ui, "게임", lx, y);
        let game = Rect::new(cx, y + 6.0, 220.0, 36.0);
        ui.p.rect(game.x, game.y, game.w, game.h, 18.0, [0xe6, 0xf6, 0xe3, 0xff]);
        ui.text("함께 짓기 · 같은 들판", game.x + game.w / 2.0, game.y + (36.0 - line_height(ui.t, 15.0, s)) / 2.0, 15.0, [0x1f, 0x6f, 0x30, 0xff], Align::Center);
        Self::form_label(ui, "방 이름", lx, y + 58.0);
        self.field(ui, Field::RoomTitle, Rect::new(cx, y + 58.0, cw, 48.0));
        Self::form_label(ui, "최대 인원", lx, y + 116.0);
        if ui.button(Rect::new(cx, y + 119.0, 48.0, 42.0), "-", ButtonStyle::Plain, self.create_max > 2) {
            self.create_max = (self.create_max.saturating_sub(if self.create_max > 10 { 5 } else { 1 })).max(2);
        }
        ui.text(&format!("{}명", self.create_max), cx + 92.0, y + 116.0 + (48.0 - line_height(ui.t, 20.0, s)) / 2.0, 20.0, CARD_TEXT, Align::Center);
        if ui.button(Rect::new(cx + 136.0, y + 119.0, 48.0, 42.0), "+", ButtonStyle::Plain, self.create_max < 50) {
            self.create_max = (self.create_max + if self.create_max >= 10 { 5 } else { 1 }).min(50);
        }
        Self::form_label(ui, "공개", lx, y + 174.0);
        // a switch: the knob slides to the right when on
        let sw = Rect::new(cx, y + 182.0, 60.0, 32.0);
        ui.p.rect(sw.x, sw.y, sw.w, sw.h, 16.0, if self.create_public { [0x4c, 0xc3, 0x5a, 0xff] } else { [0xc8, 0xcd, 0xd8, 0xff] });
        ui.p.disc(if self.create_public { sw.x + sw.w - 16.0 } else { sw.x + 16.0 }, sw.y + 16.0, 12.5, WHITE);
        ui.text(if self.create_public { "방 목록에 보여요" } else { "코드로만 들어와요" }, sw.x + sw.w + 12.0, sw.y + (32.0 - line_height(ui.t, 15.0, s)) / 2.0, 15.0, CARD_MUTED, Align::Left);
        if ui.clicked(Rect::new(sw.x - 6.0, sw.y - 6.0, 240.0, sw.h + 12.0)) {
            self.create_public = !self.create_public;
        }
        let action = self.action_bar(ui, "만든 뒤에 방 코드를 친구에게 알려 주세요", 190.0);
        if ui.button(action, "방 만들기 →", ButtonStyle::Primary, true) {
            let title = self.value(Field::RoomTitle);
            if title.is_empty() {
                self.toast("방 이름을 써 주세요.");
            } else {
                self.hub.send(PartyClient::Create { title, game: game::BUILD.into(), max: self.create_max, public: self.create_public });
            }
        }
    }

    fn draw_waiting(&mut self, ui: &mut Ui) {
        let (w, h) = ui.screen();
        scrim(ui, 0.6);
        let Some(room) = self.hub.room.clone() else {
            ui.text("방 정보를 받는 중…", w / 2.0, h / 2.0, 18.0, WHITE, Align::Center);
            return;
        };
        let s = scale(ui);
        // the top bar: leave, the room's title, its code (what friends type in)
        let bar = Rect::new(M, 10.0, w - 2.0 * M, TOP_BAR);
        glass(ui, bar, false);
        if ui.button(Rect::new(bar.x + 8.0, bar.y + 7.0, 100.0, TOP_BAR - 14.0), "‹ 나가기", ButtonStyle::Plain, true) {
            self.back();
            return;
        }
        let code_w = 196.0;
        let title = ui.t.fit(&room.title, 21.0 * s, (bar.w - 130.0 - code_w - 20.0) * s);
        ui.text(&title, bar.x + 124.0, bar.y + (TOP_BAR - line_height(ui.t, 21.0, s)) / 2.0, 21.0, WHITE, Align::Left);
        let code = Rect::new(bar.x + bar.w - 8.0 - code_w, bar.y + 7.0, code_w, TOP_BAR - 14.0);
        ui.p.rect(code.x, code.y, code.w, code.h, 10.0, [0x0b, 0x12, 0x24, 0xff]);
        ui.text("방 코드", code.x + 12.0, code.y + (code.h - line_height(ui.t, 12.0, s)) / 2.0, 12.0, DIM_TEXT, Align::Left);
        ui.text(&room.code, code.x + code.w - 12.0, code.y + (code.h - line_height(ui.t, 22.0, s)) / 2.0, 22.0, GOLD, Align::Right);
        // members (left) and chat (right), between the bars
        let body = Rect::new(M + 6.0, CONTENT_TOP + 4.0, w - 2.0 * M - 12.0, h - CONTENT_TOP - BOTTOM_BAR - 34.0);
        let split = (body.w * 0.52).min(460.0);
        let members = Rect::new(body.x, body.y, split, body.h);
        glass(ui, members, false);
        let ready_n = room.members.iter().filter(|m| m.ready || m.id == room.host).count();
        ui.text(&format!("참가자 {}/{}", room.members.len(), room.max), members.x + 18.0, members.y + 12.0, 16.0, WHITE, Align::Left);
        ui.text(&format!("준비 {}/{}", ready_n, room.members.len()), members.x + members.w - 18.0, members.y + 14.0, 14.0, GREEN_DOT, Align::Right);
        let row_h = 32.0;
        let cols = if members.w > 360.0 { 2 } else { 1 };
        let col_w = (members.w - 36.0 - (cols - 1) as f32 * 8.0) / cols as f32;
        let fits = (((members.h - 50.0) / (row_h + 6.0)).floor().max(1.0) as usize) * cols;
        for (i, m) in room.members.iter().take(fits).enumerate() {
            let (cx, cy) = ((i % cols) as f32, (i / cols) as f32);
            let r = Rect::new(members.x + 18.0 + cx * (col_w + 8.0), members.y + 42.0 + cy * (row_h + 6.0), col_w, row_h);
            let me = m.id == self.hub.seat_id;
            ui.p.rect(r.x, r.y, r.w, r.h, 10.0, if me { [0xff, 0xf3, 0xc4, 0xff] } else { [0xff, 0xff, 0xff, 0xff] });
            ui.p.disc(r.x + 14.0, r.y + r.h / 2.0, 4.5, if m.online { GREEN_DOT } else { [0xa8, 0xae, 0xbb, 0xff] });
            let label = if me { format!("{} (나)", m.name) } else { m.name.clone() };
            let label = ui.t.fit(&label, 14.5 * s, (r.w - 84.0) * s);
            ui.text(&label, r.x + 26.0, r.y + (row_h - line_height(ui.t, 14.5, s)) / 2.0, 14.5, CARD_TEXT, Align::Left);
            let badge = if m.id == room.host { Some(("방장", GOLD, INK)) } else if m.ready { Some(("준비", [0x2f, 0x9e, 0x44, 0xff], WHITE)) } else { None };
            if let Some((b, bg, fg)) = badge {
                Self::pill(ui, r.x + r.w - 6.0, r.y + 4.0, b, bg, fg);
            }
        }
        // the empty seats up to the room size, like the web waiting room (a seat waits for a friend)
        let shown = room.members.len().min(fits);
        for i in shown..(room.max as usize).min(fits) {
            let (cx, cy) = ((i % cols) as f32, (i / cols) as f32);
            let r = Rect::new(members.x + 18.0 + cx * (col_w + 8.0), members.y + 42.0 + cy * (row_h + 6.0), col_w, row_h);
            ui.p.rect(r.x, r.y, r.w, r.h, 10.0, [0xff, 0xff, 0xff, 0x1c]);
            ui.p.ring(r.x + 14.0, r.y + r.h / 2.0, 4.0, 1.5, [0xff, 0xff, 0xff, 0x60]);
            ui.text("빈 자리", r.x + 26.0, r.y + (row_h - line_height(ui.t, 13.5, s)) / 2.0, 13.5, [0xff, 0xff, 0xff, 0x80], Align::Left);
        }
        if room.members.len() > fits {
            ui.text(&format!("외 {}명", room.members.len() - fits), members.x + members.w - 18.0, members.y + members.h - 26.0, 13.0, DIM_TEXT, Align::Right);
        }
        let chat = Rect::new(body.x + split + 14.0, body.y, body.w - split - 14.0, body.h);
        glass(ui, chat, true);
        let lh = line_height(ui.t, 14.0, s) + 2.0;
        let log_h = chat.h - 74.0;
        let max_lines = (log_h / lh).floor().max(1.0) as usize;
        let mut wrapped: Vec<(String, bool)> = Vec::new();
        for (n, t, sys) in &self.chat {
            let line = if *sys { format!("· {t}") } else { format!("{n}: {t}") };
            for l in ui.t.wrap(&line, 14.0 * s, (chat.w - 36.0) * s) {
                wrapped.push((l, *sys));
            }
        }
        let start = wrapped.len().saturating_sub(max_lines);
        if wrapped.is_empty() {
            ui.text("친구에게 방 코드를 알려 주세요!", chat.x + 18.0, chat.y + 14.0, 14.0, DIM_TEXT, Align::Left);
        }
        for (i, (l, sys)) in wrapped[start..].iter().enumerate() {
            ui.text(l, chat.x + 18.0, chat.y + 14.0 + i as f32 * lh, 14.0, if *sys { DIM_TEXT } else { WHITE }, Align::Left);
        }
        let send_w = 76.0;
        self.field(ui, Field::Chat, Rect::new(chat.x + 14.0, chat.y + chat.h - 56.0, chat.w - 28.0 - send_w - 8.0, 42.0));
        if ui.button(Rect::new(chat.x + chat.w - 14.0 - send_w, chat.y + chat.h - 56.0, send_w, 42.0), "보내기", ButtonStyle::Plain, true) {
            self.send_chat();
        }
        // the action that never scrolls away: start (host) or ready
        if self.hub.is_host() {
            let all_ready = room.members.iter().all(|m| m.ready || m.id == room.host);
            let action = self.action_bar(ui, if all_ready { "모두 준비됐어요! 시작하면 다 같이 들판으로 가요" } else { "모두 준비하면 시작할 수 있어요" }, 220.0);
            if ui.button(action, "▶ 게임 시작", ButtonStyle::Primary, true) {
                self.hub.send(PartyClient::Start);
            }
        } else {
            let ready = self.hub.me().is_some_and(|m| m.ready);
            let action = self.action_bar(ui, if ready { "방장이 시작하기를 기다려요" } else { "준비되면 눌러요" }, 200.0);
            if ui.button(action, if ready { "준비 취소" } else { "준비 완료" }, if ready { ButtonStyle::Plain } else { ButtonStyle::Go }, true) {
                self.hub.send(PartyClient::Ready { ready: !ready });
            }
        }
    }

    /// A centred white card for the entering / in-field screens.
    fn status_card(ui: &mut Ui, height: f32) -> Rect {
        let (w, h) = ui.screen();
        let cw = (w - 2.0 * M).min(560.0);
        let ch = height.min(h - 2.0 * M);
        white_card(ui, Rect::new((w - cw) / 2.0, (h - ch) / 2.0, cw, ch), false)
    }

    fn draw_entering(&mut self, ui: &mut Ui) {
        scrim(ui, 0.75);
        let Some(c) = &self.class else { return };
        let title = c.title.clone();
        let frac = match c.total {
            None => 0.05,
            Some(0) => 1.0,
            Some(t) => (c.got as f32 / t as f32).clamp(0.0, 1.0),
        };
        let detail = match c.total {
            None => "서버에 들어가는 중…".to_owned(),
            Some(t) => format!("들판 불러오는 중 · 블록 {}/{}개", c.got.min(t), t),
        };
        let face = Self::status_card(ui, 210.0);
        let s = scale(ui);
        let title = ui.t.fit(&title, 24.0 * s, face.w * s);
        ui.text(&title, face.x + face.w / 2.0, face.y + 2.0, 24.0, CARD_TEXT, Align::Center);
        let bar = Rect::new(face.x + 18.0, face.y + 56.0, face.w - 36.0, 18.0);
        ui.p.rect(bar.x, bar.y, bar.w, bar.h, 9.0, [0xe6, 0xea, 0xf2, 0xff]);
        ui.p.rect(bar.x, bar.y, (bar.w * frac).max(bar.h), bar.h, 9.0, GOLD);
        ui.text(&detail, face.x + face.w / 2.0, face.y + 86.0, 15.0, CARD_MUTED, Align::Center);
        if ui.button(Rect::new(face.x + face.w / 2.0 - 65.0, face.y + face.h - 48.0, 130.0, 46.0), "취소", ButtonStyle::Plain, true) {
            self.leave_class();
        }
    }

    /// The field HUD, over the live world: where you are and who is here (top left), leave and
    /// chat (top right), the chat log under the title. Everything sits in the top band so the
    /// touch stick (bottom left) and jump (bottom right) keep the bottom of the screen.
    fn draw_in_field(&mut self, ui: &mut Ui) {
        let (w, _) = ui.screen();
        let s = scale(ui);
        self.hud_rects.clear();
        let Some(c) = &self.class else { return };
        let (title, online, teacher, now) = (c.title.clone(), c.online(), c.teacher, self.now);
        let lines: Vec<(String, bool)> = c.chat.iter().rev().take(6).filter(|l| now - l.at < 14.0 || self.focus == Some(Field::Chat)).map(|l| {
            if l.system { (format!("· {}", l.text), true) } else { (format!("{}{}: {}", l.name, if l.teacher { " 선생님" } else { "" }, l.text), false) }
        }).collect();
        // the plate: the class, who it is (a teacher's or a student's view) and who is online
        let (sw, sh) = ui.screen();
        let pill = crate::hud_layout::layout(sw, sh, false, true).plate;
        ui.p.plate(ui.t, pill, if teacher { Art::NavEdu } else { Art::NavFriends }, &title, Some(&format!("{online}명")));
        self.hud_rects.push(pill);
        // chat log, newest at the bottom, on a soft glass strip
        if !lines.is_empty() {
            let lh = line_height(ui.t, 14.0, s) + 4.0;
            let lw = (w * 0.42).clamp(260.0, 460.0);
            let mut wrapped: Vec<(String, bool)> = Vec::new();
            for (l, sys) in lines.iter().rev() {
                for part in ui.t.wrap(l, 14.0 * s, (lw - 24.0) * s) {
                    wrapped.push((part, *sys));
                }
            }
            let shown = &wrapped[wrapped.len().saturating_sub(7)..];
            let box_r = Rect::new(pill.x, pill.y + pill.h + 10.0, lw, shown.len() as f32 * lh + 14.0);
            ui.p.rect(box_r.x, box_r.y, box_r.w, box_r.h, 12.0, [0x0b, 0x16, 0x30, 0x90]);
            for (i, (l, sys)) in shown.iter().enumerate() {
                ui.text(l, box_r.x + 12.0, box_r.y + 7.0 + i as f32 * lh, 14.0, if *sys { DIM_TEXT } else { WHITE }, Align::Left);
            }
        }
        // a desktop types into the chat inline (a phone gets the top editing bar)
        if self.focus == Some(Field::Chat) {
            let f = Rect::new((w - (w * 0.5).clamp(320.0, 560.0)) / 2.0, 64.0, (w * 0.5).clamp(320.0, 560.0), 46.0);
            self.field(ui, Field::Chat, f);
            self.hud_rects.push(f);
        }
    }
}

/// A slider over `r` (a row): the track, the filled part, the knob and the value at its end.
/// Returns the new position (0–1) while it is dragged or tapped.
fn slider(ui: &mut Ui, r: Rect, at: f32, value: &str) -> Option<f32> {
    let s = scale(ui);
    let vw = 64.0;
    let track = Rect::new(r.x + 12.0, r.y + r.h / 2.0 - 4.0, r.w - vw - 30.0, 8.0);
    let at = at.clamp(0.0, 1.0);
    ui.p.rect(track.x, track.y, track.w, track.h, 4.0, [0xdd, 0xe3, 0xec, 0xff]);
    ui.p.rect(track.x, track.y, (track.w * at).max(track.h), track.h, 4.0, [0x1f, 0x6f, 0xd8, 0xff]);
    let kx = track.x + track.w * at;
    ui.p.disc(kx, track.y + 5.5, 13.0, [0x00, 0x00, 0x00, 0x22]);
    ui.p.disc(kx, track.y + 4.0, 13.0, WHITE);
    ui.p.disc(kx, track.y + 4.0, 6.0, [0x1f, 0x6f, 0xd8, 0xff]);
    ui.text(value, r.x + r.w - 6.0, r.y + (r.h - line_height(ui.t, 15.0, s)) / 2.0, 15.0, CARD_TEXT, Align::Right);
    // the whole row height is the touch target; a drag that started in it keeps steering
    let hit = Rect::new(track.x - 14.0, r.y, track.w + 28.0, r.h);
    let p = ui.ptr;
    if ui.enabled && p.down && hit.contains(p.press_at.0, p.press_at.1) {
        return Some(((p.pos.0 - track.x) / track.w).clamp(0.0, 1.0));
    }
    None
}

fn scale(ui: &Ui) -> f32 {
    // pixels per dp: the painter's own (text widths are measured in pixels)
    let (w, _) = ui.p.screen();
    ui.p.size_px().0 / w
}

fn short_why(why: &craftyap_net::link::CloseWhy) -> &'static str {
    use craftyap_net::link::CloseWhy::*;
    match why {
        Unreachable(_) => "서버에 닿지 않아요",
        Silent => "응답 없음",
        Server { .. } => "서버가 닫음",
        Broken(_) => "네트워크 끊김",
        Local => "닫음",
    }
}

fn draw_toast(ui: &mut Ui, msg: &str) {
    // a compact notice under the top bar: soft navy glass, white text, never a big plaque
    let (w, _) = ui.screen();
    let s = scale(ui);
    let max = (w - 120.0).min(520.0);
    let lines = ui.t.wrap(msg, 15.0 * s, (max - 36.0) * s);
    let lh = line_height(ui.t, 15.0, s);
    let tw = lines.iter().map(|l| ui.t.width(l, 15.0 * s) / s).fold(0.0, f32::max) + 36.0;
    let h = lines.len() as f32 * lh + 16.0;
    let r = Rect::new((w - tw) / 2.0, crate::hud_layout::MARGIN + 4.0, tw, h);
    ui.p.rect(r.x + 2.0, r.y + 4.0, r.w - 4.0, r.h, h.min(40.0) / 2.0, [0x05, 0x0f, 0x28, 0x40]);
    ui.p.rect(r.x, r.y, r.w, r.h, h.min(40.0) / 2.0, [0x16, 0x24, 0x48, 0xee]);
    ui.p.rect(r.x + 14.0, r.y + r.h - 3.0, r.w - 28.0, 3.0, 1.5, [0xff, 0xd2, 0x1c, 0xff]);
    for (i, l) in lines.iter().enumerate() {
        ui.text(l, w / 2.0, r.y + 7.0 + i as f32 * lh, 15.0, WHITE, Align::Center);
    }
}
