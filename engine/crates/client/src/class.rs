//! A classroom / party field session on the native client: the web's `ClassClient` + `ClassSync`
//! reduced to what the app does today (N4f): stream the field in, keep it in step with everyone's
//! edits, show classmates where the server says they are, chat, and report our own position.
//!
//! The session is socket-only state; the world lives in `field.rs`. Edits arrive here in ABSOLUTE
//! coordinates and wait in `pending` until the game applies them to its window.
//!
//! Classmates are drawn on the server's clock (craft/remoteTrack.ts, simplified): each snapshot
//! carries `ts` and each player its arrival time `at`; the app draws everyone RENDER_DELAY behind
//! the newest server time, between the two samples around that moment, so network jitter never
//! shows as stutter. A jump of more than 8 m is a teleport and snaps.

use craftyap_net::link::{CloseWhy, Event, Link};
use craftyap_net::protocol::*;
use std::collections::{HashMap, VecDeque};

/// How far behind the newest server time classmates are drawn (remoteTrack.ts RENDER_DELAY_MS).
const RENDER_DELAY: f64 = 0.12;
const TELEPORT: f64 = 8.0;
/// k-move goes out at the web's rate (every 6th 60 Hz tick).
pub const MOVE_EVERY: f64 = 0.1;

#[derive(Clone, Copy, Debug, PartialEq)]
struct Sample {
    t: f64,
    pos: [f64; 3],
    yaw: f64,
}

/// One classmate as drawn.
#[derive(Clone, Debug)]
pub struct Remote {
    pub id: String,
    /// The wire's character ("tt"; absent = HOME).
    pub character: Option<String>,
    /// Drawn speed (m/s), eased.
    pub speed: f32,
    pub name: String,
    pub teacher: bool,
    pub anim: String,
    /// What their hands do (homeRig.ts performAction): the action, its sequence number, looping.
    pub action: (String, u32, bool),
    /// Their emote and its sequence (a new one plays its gesture).
    pub emote: (String, u32),
    samples: VecDeque<Sample>,
    pub last_drawn: Option<[f64; 3]>,
}

impl Remote {
    /// Position and yaw at server time `t` (seconds), between the samples around it.
    pub fn at(&self, t: f64) -> Option<([f64; 3], f64)> {
        let s = &self.samples;
        let last = *s.back()?;
        if t >= last.t {
            return Some((last.pos, last.yaw));
        }
        for i in (1..s.len()).rev() {
            let (a, b) = (s[i - 1], s[i]);
            if t >= a.t {
                let k = ((t - a.t) / (b.t - a.t).max(1e-6)).clamp(0.0, 1.0);
                let lerp = |p: f64, q: f64| p + (q - p) * k;
                let mut dyaw = b.yaw - a.yaw;
                while dyaw > std::f64::consts::PI {
                    dyaw -= std::f64::consts::TAU;
                }
                while dyaw < -std::f64::consts::PI {
                    dyaw += std::f64::consts::TAU;
                }
                return Some(([lerp(a.pos[0], b.pos[0]), lerp(a.pos[1], b.pos[1]), lerp(a.pos[2], b.pos[2])], a.yaw + dyaw * k));
            }
        }
        Some((s[0].pos, s[0].yaw))
    }

    fn push(&mut self, sample: Sample) {
        if let Some(last) = self.samples.back() {
            if sample.t <= last.t {
                return; // a repeated or older report
            }
            let d = (0..3).map(|i| (sample.pos[i] - last.pos[i]).powi(2)).sum::<f64>().sqrt();
            if d > TELEPORT {
                self.samples.clear(); // a teleport / gather: snap, never slide across the map
            }
        }
        self.samples.push_back(sample);
        while self.samples.len() > 30 {
            self.samples.pop_front();
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ChatLine {
    pub name: String,
    pub text: String,
    pub system: bool,
    pub teacher: bool,
    /// Local time it arrived (lines fade after a while in play).
    pub at: f64,
}

/// Why a session ended (for the menu's toast).
#[derive(Clone, Debug, PartialEq)]
pub enum Ended {
    Error(String),
    Kicked,
    Closed,
    Lost(CloseWhy),
}

#[derive(Clone,Debug,Default)]
#[allow(dead_code)] // `size` is the server's word kept whole: the app does not show the team size yet
pub struct DrillState {pub size:u32,pub teams:Vec<(String,u32)>,pub go:Vec<u32>,pub run:u32,pub reports:Vec<DrillProgress>}
pub struct ClassSession {
    pub theme:String,
    pub drill:Option<DrillState>,
    link: Link,
    pub room: String,
    pub title: String,
    pub teacher: bool,
    pub party: bool,
    pub you: String,
    pub key: Option<String>,
    pub settings: Option<ClassSettings>,
    pub members: Vec<ClassMember>,
    /// The field's edit count from the welcome, and how many have streamed in.
    pub total: Option<u32>,
    pub got: u32,
    /// Edits for the field, oldest first (absolute coordinates).
    pending: Vec<Edit>,
    /// Water held inside shaped blocks (s-k-wet), waiting for the field.
    pending_wet: Vec<Wet>,
    pub reset: bool,
    pub water_drained: bool,
    pub remotes: HashMap<String, Remote>,
    pub chat: Vec<ChatLine>,
    pub ended: Option<Ended>,
    /// Newest server time heard (s) and the local time it was heard at.
    server_time: Option<(f64, f64)>,
    move_timer: f64,
    pub gather: Option<[f64; 3]>,
    /// The last gather was a nudge back inside the student's plot fence (the app draws no fence:
    /// it says why instead).
    pub gather_nudge: bool,
    /// The teacher froze the class (F2 → 모두 멈춰): a student stands still and builds nothing.
    pub frozen: bool,
    /// Lines to show as toasts: the teacher's announcements and lesson changes.
    pub notices: Vec<String>,
    /// The server's furniture layout (absolute cells) and a counter bumped on every change.
    pub furniture: Vec<Furniture>,
    pub furniture_version: u64,
}

impl ClassSession {
    pub fn new(link: Link, room: String, title: String, teacher: bool, party: bool) -> Self {
        ClassSession {
            theme:"craft".into(),drill:None,
            link,
            room,
            title,
            teacher,
            party,
            you: String::new(),
            key: None,
            settings: None,
            members: Vec::new(),
            total: None,
            got: 0,
            pending: Vec::new(),
            pending_wet: Vec::new(),
            reset: false,
            water_drained: false,
            remotes: HashMap::new(),
            chat: Vec::new(),
            ended: None,
            server_time: None,
            move_timer: 0.0,
            gather: None,
            gather_nudge: false,
            frozen: false,
            notices: Vec::new(),
            furniture: Vec::new(),
            furniture_version: 0,
        }
    }

    /// The whole field has arrived (`connect()` resolving on the web).
    pub fn ready(&self) -> bool {
        self.total.is_some_and(|t| self.got >= t)
    }

    pub fn online(&self) -> usize {
        self.members.iter().filter(|m| m.online).count()
    }

    fn member_name(&self, id: &str) -> (String, bool) {
        self.members.iter().find(|m| m.id == id).map_or((String::new(), false), |m| (m.name.clone(), m.role == "teacher"))
    }

    pub fn take_wet(&mut self) -> Vec<Wet> {
        std::mem::take(&mut self.pending_wet)
    }

    /// Edits waiting for the field (taken once).
    pub fn take_edits(&mut self) -> Vec<Edit> {
        std::mem::take(&mut self.pending)
    }

    /// Read everything that arrived. `now`: local seconds.
    pub fn poll(&mut self, now: f64) {
        for ev in self.link.poll() {
            match ev {
                Event::Text(text) => match decode::<ClassServer>(&text) {
                    Some(msg) => self.receive(msg, now),
                    None => log::warn!("class: unreadable message skipped ({} bytes)", text.len()),
                },
                Event::Closed { why, .. } => {
                    if self.ended.is_none() {
                        self.ended = Some(Ended::Lost(why));
                    }
                }
                Event::Open => {}
            }
        }
    }

    fn receive(&mut self, msg: ClassServer, now: f64) {
        match msg {
            ClassServer::Welcome { you, key, members, settings, edit_count, keepalive, furniture, theme, .. } => {
                self.theme=theme.unwrap_or_else(||"craft".into());
                self.furniture = furniture;
                self.furniture_version += 1;
                self.you = you;
                self.key = Some(key);
                self.members = members;
                self.settings = Some(settings);
                self.total = Some(edit_count);
                if let Some(k) = keepalive {
                    self.link.set_silence_limit(Some(std::time::Duration::from_secs_f64(k * 5.0)));
                }
            }
            ClassServer::World { edits } => {
                self.got += edits.len() as u32;
                self.pending.extend(edits);
            }
            ClassServer::WorldReset => {
                self.pending.clear();
                self.reset = true;
            }
            ClassServer::WaterDrained => {
                // Keep the barrier's order relative to edits queued before and after it.
                for e in &mut self.pending {
                    if (19..=28).contains(&e.3) { e.3 = 0; e.4 = 0; }
                }
                self.pending_wet.clear();
                self.water_drained = true;
                self.notices.push("💧 반 전체의 물을 모두 뺐어요".into());
            }
            ClassServer::Edit { edits, .. } => self.pending.extend(edits),
            // our refused edits come back with the server's values: they are edits like any other
            ClassServer::Reject { edits, .. } => self.pending.extend(edits),
            ClassServer::Members { members } => {
                self.members = members;
                let online: Vec<String> = self.members.iter().filter(|m| m.online).map(|m| m.id.clone()).collect();
                self.remotes.retain(|id, _| online.contains(id));
            }
            ClassServer::Snap { ts, players } => {
                let snap_t = ts.map(|ms| ms / 1000.0);
                if let Some(t) = snap_t {
                    self.server_time = Some((t, now));
                }
                for p in players {
                    if p.id == self.you {
                        continue;
                    }
                    let t = p.at.map(|ms| ms / 1000.0).or(snap_t).unwrap_or(now);
                    let (name, teacher) = self.member_name(&p.id);
                    let r = self.remotes.entry(p.id.clone()).or_insert_with(|| Remote { id: p.id.clone(), character: None, speed: 0.0, name: String::new(), teacher, anim: String::new(), action: ("none".into(), 0, false), emote: ("none".into(), 0), samples: VecDeque::new(), last_drawn: None });
                    if !name.is_empty() {
                        r.name = name;
                        r.teacher = teacher;
                    }
                    r.anim = p.anim;
                    r.emote = (p.look.emote.clone().unwrap_or_else(|| "none".into()), p.look.emote_seq.unwrap_or(0));
                    r.action = (p.look.action.clone().unwrap_or_else(|| "none".into()), p.look.action_seq.unwrap_or(0), p.look.action_loop.unwrap_or(false));
                    if p.look.character.is_some() {
                        r.character = p.look.character.clone();
                    }
                    r.push(Sample { t, pos: p.pos, yaw: p.yaw });
                }
            }
            ClassServer::Chat { name, text, role, system, .. } => {
                self.chat.push(ChatLine { name, text, system: system.unwrap_or(false), teacher: role == "teacher", at: now });
                if self.chat.len() > 80 {
                    self.chat.remove(0);
                }
            }
            ClassServer::Gather { pos, nudge, .. } => {
                self.gather = Some(pos);
                self.gather_nudge = nudge.unwrap_or(false);
            }
            ClassServer::Settings { settings } => self.settings = Some(settings),
            ClassServer::Lesson { frozen, .. } => {
                let frozen = frozen.unwrap_or(false);
                if frozen != self.frozen && !self.teacher {
                    self.notices.push(if frozen { "✋ 잠깐! 선생님을 봐 주세요".into() } else { "▶️ 다시 움직일 수 있어요".into() });
                }
                self.frozen = frozen;
            }
            ClassServer::Announce { text } => self.notices.push(format!("📢 {text}")),
            ClassServer::Kicked => self.ended = Some(Ended::Kicked),
            ClassServer::Closed => self.ended = Some(Ended::Closed),
            ClassServer::Error { code } => self.ended = Some(Ended::Error(code)),
            // the whole layout every time (a refusal included): replace it
            ClassServer::Furniture { furniture, .. } => {
                self.furniture = furniture;
                self.furniture_version += 1;
            }
            ClassServer::Wet { cells } => self.pending_wet.extend(cells),
            // taps arrive later
            // power plants are web-only for now: the app neither draws nor builds them
            ClassServer::Drill{size,teams,go,run,reports,..}=>{self.drill=Some(DrillState{size,teams,go,run,reports});}
            ClassServer::Bonk { .. } | ClassServer::Room { .. } | ClassServer::Seats { .. } | ClassServer::Plants { .. } => {}
        }
    }

    /// The server time to draw classmates at.
    pub fn draw_time(&self, now: f64) -> f64 {
        match self.server_time {
            Some((t, heard)) => t + (now - heard) - RENDER_DELAY,
            None => now - RENDER_DELAY,
        }
    }

    /// Report our position at the web's rate. `pos`: feet, ABSOLUTE coordinates.
    /// `held`: the held item's id and the swing phase (0..1); `look`: the character and emote
    /// (craftGame.ts presentation; the action and the held item are filled in here).
    #[allow(clippy::too_many_arguments)]
    pub fn tick_move(&mut self, dt: f64, now: f64, pos: [f64; 3], yaw: f64, anim: &str, action: (&str, u32, bool), held: Option<(&str, f32)>, base: Presentation) {
        self.move_timer += dt;
        if self.move_timer < MOVE_EVERY {
            return;
        }
        // the timer keeps its remainder (classSync.ts: moves go out every 6th tick)
        self.move_timer = (self.move_timer - MOVE_EVERY).min(MOVE_EVERY);
        // our hands, so a classmate's game shows us digging and placing (absent = nothing)
        let mut look = base;
        if !(action.0 == "none" && action.1 == 0) {
            look.action = Some(action.0.to_owned());
            look.action_seq = Some(action.1);
            look.action_loop = Some(action.2);
        }
        if let Some((id, phase)) = held {
            look.held_item = Some(Some(id.to_owned()));
            look.tool_option = Some("balanced".into());
            if phase > 0.0 {
                look.tool_phase = Some(f64::from(phase.clamp(0.0, 1.0)));
            }
        }
        let msg = ClassClient::Move { pos, yaw, anim: anim.to_owned(), ct: Some((now * 1000.0).round()), look };
        self.link.send(encode(&msg));
    }

    /// Our block writes (absolute coordinates), at most 8 a message (k-edit).
    pub fn send_edits(&mut self, edits: Vec<Edit>) {
        for chunk in edits.chunks(8) {
            self.link.send(encode(&ClassClient::Edit { edits: chunk.to_vec() }));
        }
    }

    pub fn send_chat(&mut self, text: String) {
        self.link.send(encode(&ClassClient::Chat { text }));
    }
    pub fn drill_command(&mut self,op:&str,size:Option<u32>,team:Option<u32>){self.link.send(encode(&ClassClient::Drill{op:op.into(),size,team}));}
    pub fn drill_report(&mut self,step:u32,stars:Option<u32>,seconds:Option<u32>){self.link.send(encode(&ClassClient::DrillReport{step,stars,seconds,quiz:None,quiz_score:None}));}
}

#[cfg(test)]
mod tests {
    use super::*;

    fn remote() -> Remote {
        Remote { id: "a".into(), character: None, speed: 0.0, name: "a".into(), teacher: false, anim: "idle".into(), action: ("none".into(), 0, false), emote: ("none".into(), 0), samples: VecDeque::new(), last_drawn: None }
    }

    #[test]
    fn classmates_are_drawn_between_samples() {
        let mut r = remote();
        r.push(Sample { t: 1.0, pos: [0.0, 4.0, 0.0], yaw: 0.0 });
        r.push(Sample { t: 1.1, pos: [1.0, 4.0, 0.0], yaw: 1.0 });
        let (p, yaw) = r.at(1.05).unwrap();
        assert!((p[0] - 0.5).abs() < 1e-9 && (yaw - 0.5).abs() < 1e-9);
        assert_eq!(r.at(5.0).unwrap().0, [1.0, 4.0, 0.0], "past the newest sample: hold it");
        assert_eq!(r.at(0.0).unwrap().0, [0.0, 4.0, 0.0]);
    }

    #[test]
    fn the_short_way_round_and_teleports_snap() {
        let mut r = remote();
        r.push(Sample { t: 1.0, pos: [0.0; 3], yaw: 3.0 });
        r.push(Sample { t: 2.0, pos: [0.0; 3], yaw: -3.0 });
        let (_, yaw) = r.at(1.5).unwrap();
        assert!(yaw > 3.0, "turning through ±π goes the short way: {yaw}");
        r.push(Sample { t: 3.0, pos: [50.0, 0.0, 0.0], yaw: 0.0 });
        assert_eq!(r.at(2.5).unwrap().0, [50.0, 0.0, 0.0], "a jump of 50 m snaps, never slides");
        r.push(Sample { t: 2.9, pos: [1.0, 0.0, 0.0], yaw: 0.0 });
        assert_eq!(r.samples.len(), 1, "an older report is dropped");
    }
}
