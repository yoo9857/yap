//! Sound: the web's own recordings (`apps/client/public/audio/sfx`, compiled in by build.rs with
//! its manifest) played by the rules of `audio/materialSounds.ts`:
//!
//! - blocks sound like their surface family (`sampleBank`): stone/ore, wood, metal, glass/gem hits
//!   and breaks; soft ground breaks with the gravel crunch; placing is a short synthesized brick
//!   snap (the web's is a synth too, never a recording);
//! - footsteps follow the block underfoot (`stepBank`), very quiet, wet in shallow water;
//! - every play varies: a random clip, never either of the last two picks, ±7 % pitch.
//!
//! The clips are decoded to PCM on a background thread at start; until a bank is ready its plays
//! are skipped. No audio device (a headless desktop, a failing driver) means silence, never a crash.
//! The rules are pure (`step_bank`, `block_bank`, `Picker`) and unit-tested.

use craftyap_core::surface::Family;
use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver};
use std::sync::Arc;

include!(concat!(env!("OUT_DIR"), "/sounds_gen.rs"));

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlockSound {
    Hit,
    Break,
}

/// materialSounds.ts `stepBank`: the footstep bank and its level.
pub fn step_bank(family: Family, wet: bool) -> (&'static str, f32) {
    if wet {
        return ("step-wet", 0.065);
    }
    match family {
        Family::Wood => ("step-wood", 0.05),
        Family::Dirt | Family::Grass | Family::GrassSide | Family::Sand => ("step-grass", 0.055),
        Family::Snow => ("step-snow", 0.045),
        Family::Wool => ("step-snow", 0.03),
        _ => ("step-stone", 0.045),
    }
}

/// materialSounds.ts `sampleBank` for a hit or a break (None: the web plays a synth there).
pub fn block_bank(kind: BlockSound, family: Family) -> Option<(&'static str, f32)> {
    let hit = kind == BlockSound::Hit;
    match family {
        Family::Wood => Some(if hit { ("hit-wood", 0.42) } else { ("break-wood", 0.5) }),
        Family::Metal => Some(if hit { ("hit-metal", 0.35) } else { ("break-metal", 0.45) }),
        Family::Glass | Family::Gem => Some(if hit { ("hit-glass", 0.3) } else { ("break-glass", 0.45) }),
        Family::Dirt | Family::Grass | Family::GrassSide => (!hit).then_some(("step-gravel", 0.5)),
        Family::Sand => (!hit).then_some(("step-gravel", 0.42)),
        Family::Snow | Family::Wool => None,
        // stone, ore, coat, anything new
        _ => Some(if hit { ("hit-stone", 0.42) } else { ("break-stone", 0.55) }),
    }
}

/// "never either of its last two picks" (a bank of 3+), else just not the last.
#[derive(Default)]
pub struct Picker {
    last: HashMap<&'static str, [Option<usize>; 2]>,
    seed: u32,
}

impl Picker {
    fn rand(&mut self) -> f32 {
        self.seed = self.seed.wrapping_mul(1664525).wrapping_add(1013904223);
        (self.seed >> 8) as f32 / (1 << 24) as f32
    }
    pub fn pick(&mut self, bank: &'static str, n: usize) -> usize {
        if n <= 1 {
            return 0;
        }
        let recent = *self.last.get(bank).unwrap_or(&[None, None]);
        let avoid = |i: usize| recent[0] == Some(i) || (n > 2 && recent[1] == Some(i));
        let free: Vec<usize> = (0..n).filter(|&i| !avoid(i)).collect();
        let i = free[((self.rand() * free.len() as f32) as usize).min(free.len() - 1)];
        self.last.insert(bank, [Some(i), recent[0]]);
        i
    }
    /// ±7 % pitch.
    pub fn pitch(&mut self) -> f32 {
        0.93 + self.rand() * 0.14
    }
}

#[derive(Clone)]
struct Clip {
    rate: u32,
    channels: u16,
    pcm: Arc<Vec<f32>>,
}

fn decode(bytes: &'static [u8]) -> Option<Clip> {
    use rodio::Source;
    let d = rodio::Decoder::new(std::io::Cursor::new(bytes)).ok()?;
    let (rate, channels) = (d.sample_rate(), d.channels());
    let pcm: Vec<f32> = d.collect();
    Some(Clip { rate: rate.into(), channels: channels.into(), pcm: Arc::new(pcm) })
}

/// The web's brick snap, synthesized (materialSounds.ts `place`: a short high click over a low thock).
fn snap(rate: u32) -> Vec<f32> {
    let n = (rate as f32 * 0.09) as usize;
    (0..n)
        .map(|i| {
            let t = i as f32 / rate as f32;
            let click = (t * 2.0 * std::f32::consts::PI * 2400.0).sin() * (-t * 140.0).exp() * 0.5;
            let thock = (t * 2.0 * std::f32::consts::PI * (420.0 - t * 1800.0)).sin() * (-t * 45.0).exp();
            (click + thock) * 0.6
        })
        .collect()
}

pub struct Sound {
    stream: Option<rodio::MixerDeviceSink>,
    banks: HashMap<&'static str, Vec<Clip>>,
    loading: Option<Receiver<(&'static str, Clip)>>,
    picker: Picker,
    snap: Option<Clip>,
    /// Plays this frame (a burst — an avalanche of breaks — never stacks up into noise).
    this_frame: u32,
    /// Banks heard at least once (logged the first time: proof the events reach the speaker).
    heard: std::collections::HashSet<&'static str>,
    /// The effects volume (settings.sfx, 0–1).
    pub volume: f32,
}

const MAX_PER_FRAME: u32 = 6;

impl Sound {
    pub fn start() -> Sound {
        let stream = match rodio::DeviceSinkBuilder::open_default_sink() {
            Ok(s) => Some(s),
            Err(e) => {
                log::warn!("sound: no audio output ({e}); the app stays silent");
                None
            }
        };
        let (tx, rx) = mpsc::channel();
        let manifest: HashMap<String, Vec<String>> = serde_json::from_str(MANIFEST).unwrap_or_default();
        let started = std::thread::Builder::new().name("sound-decode".into()).spawn(move || {
            let t = std::time::Instant::now();
            let mut n = 0;
            for (bank, files) in &manifest {
                let Some(&bank) = BANK_NAMES.iter().find(|b| **b == bank.as_str()) else { continue };
                for f in files {
                    let Some((_, bytes)) = CLIPS.iter().find(|(name, _)| name == f) else { continue };
                    if let Some(clip) = decode(bytes) {
                        n += 1;
                        if tx.send((bank, clip)).is_err() {
                            return;
                        }
                    }
                }
            }
            log::info!("sound: {n} clips decoded in {:.0} ms", t.elapsed().as_secs_f64() * 1000.0);
        });
        if let Err(e) = started {
            log::warn!("sound: cannot start the decoder ({e})");
        }
        Sound { stream, banks: HashMap::new(), loading: Some(rx), picker: Picker::default(), snap: Some(Clip { rate: 44100, channels: 1, pcm: Arc::new(snap(44100)) }), this_frame: 0, heard: Default::default(), volume: 1.0 }
    }

    /// Once a frame: take decoded clips, reset the burst cap.
    pub fn frame(&mut self) {
        self.this_frame = 0;
        if let Some(rx) = &self.loading {
            loop {
                match rx.try_recv() {
                    Ok((bank, clip)) => self.banks.entry(bank).or_default().push(clip),
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => {
                        self.loading = None;
                        break;
                    }
                }
            }
        }
    }

    fn play_clip(&mut self, clip: Clip, vol: f32, pitch: f32) {
        let Some(stream) = &self.stream else { return };
        let vol = vol * self.volume;
        if vol <= 0.001 {
            return;
        }
        if self.this_frame >= MAX_PER_FRAME {
            return;
        }
        self.this_frame += 1;
        use rodio::Source;
        let (Some(ch), Some(rate)) = (std::num::NonZero::new(clip.channels), std::num::NonZero::new(clip.rate)) else { return };
        let src = rodio::buffer::SamplesBuffer::new(ch, rate, clip.pcm.as_ref().clone()).speed(pitch).amplify(vol);
        stream.mixer().add(src);
    }

    pub fn play(&mut self, bank: &'static str, vol: f32) {
        let Some(clips) = self.banks.get(bank) else { return };
        let i = self.picker.pick(bank, clips.len());
        let clip = clips[i].clone();
        if self.stream.is_some() && self.heard.insert(bank) {
            log::info!("sound: first {bank}");
        }
        let pitch = self.picker.pitch();
        self.play_clip(clip, vol, pitch);
    }

    pub fn step(&mut self, family: Family, wet: bool) {
        let (bank, vol) = step_bank(family, wet);
        self.play(bank, vol);
    }

    pub fn block(&mut self, kind: BlockSound, family: Family) {
        if let Some((bank, vol)) = block_bank(kind, family) {
            self.play(bank, vol);
        }
    }

    pub fn place(&mut self) {
        if let Some(clip) = self.snap.clone() {
            let pitch = self.picker.pitch();
            self.play_clip(clip, 0.32, pitch);
        }
    }
}

/// The surface family of a block id (blocks sound like what they are made of).
pub fn family_of_block(block: u8) -> Family {
    crate::building::def_by_id(block).map_or(Family::Stone, |d| craftyap_core::surface::family_of(d.key))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn banks_follow_the_web() {
        assert_eq!(step_bank(Family::Wood, false).0, "step-wood");
        assert_eq!(step_bank(Family::Grass, false).0, "step-grass");
        assert_eq!(step_bank(Family::Stone, true).0, "step-wet");
        assert_eq!(block_bank(BlockSound::Hit, Family::Ore), Some(("hit-stone", 0.42)));
        assert_eq!(block_bank(BlockSound::Hit, Family::Dirt), None, "soft ground digs with the synth");
        assert_eq!(block_bank(BlockSound::Break, Family::Sand), Some(("step-gravel", 0.42)));
        assert_eq!(block_bank(BlockSound::Break, Family::Wool), None);
        // every bank the rules name ships with the web
        for b in ["step-wet", "step-wood", "step-grass", "step-snow", "step-stone", "hit-wood", "break-wood", "hit-metal", "break-metal", "hit-glass", "break-glass", "step-gravel", "hit-stone", "break-stone"] {
            assert!(BANK_NAMES.contains(&b), "{b} missing from the manifest");
        }
    }

    #[test]
    fn a_pick_never_repeats_the_last_two() {
        let mut p = Picker::default();
        let mut last = [usize::MAX; 2];
        for _ in 0..500 {
            let i = p.pick("hit-wood", 5);
            assert!(i < 5 && i != last[0] && i != last[1]);
            last = [i, last[0]];
            let k = p.pitch();
            assert!((0.93..=1.07).contains(&k));
        }
        assert_eq!(p.pick("solo", 1), 0);
        let mut prev = p.pick("pair", 2);
        for _ in 0..50 {
            let i = p.pick("pair", 2);
            assert_ne!(i, prev);
            prev = i;
        }
    }

    #[test]
    fn every_clip_in_the_manifest_is_compiled_in_and_decodes() {
        let manifest: HashMap<String, Vec<String>> = serde_json::from_str(MANIFEST).unwrap();
        let mut n = 0;
        for files in manifest.values() {
            for f in files {
                let (_, bytes) = CLIPS.iter().find(|(name, _)| name == f).unwrap_or_else(|| panic!("{f} not compiled in"));
                let clip = decode(bytes).unwrap_or_else(|| panic!("{f} does not decode"));
                assert!(clip.pcm.len() > 100 && clip.rate >= 8000, "{f}");
                n += 1;
            }
        }
        assert!(n >= 100);
        assert!(snap(44100).iter().all(|s| s.is_finite() && s.abs() <= 1.0));
    }
}
