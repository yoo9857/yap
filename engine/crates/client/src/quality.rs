//! Quality presets, from low-end phones to flagships. `Auto` starts from what the GPU reports and
//! steps down when frames run long (see `AutoTuner`).

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Preset {
    Low,
    Medium,
    High,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Settings {
    /// Fraction of the window's pixels the scene renders at (1.0 = native).
    pub render_scale: f32,
    /// Multisample count (1 = off).
    pub msaa: u32,
    /// How far chunks are drawn, in metres.
    pub view_distance: f32,
}

impl Preset {
    pub fn settings(self) -> Settings {
        match self {
            Preset::Low => Settings { render_scale: 0.6, msaa: 1, view_distance: 48.0 },
            Preset::Medium => Settings { render_scale: 0.8, msaa: 1, view_distance: 80.0 },
            Preset::High => Settings { render_scale: 1.0, msaa: 4, view_distance: 128.0 },
        }
    }

    /// The starting point for `Auto`: software or low-limit GPUs start low, integrated / mobile
    /// GPUs medium, discrete ones high.
    pub fn initial(info: &wgpu::AdapterInfo, limits: &wgpu::Limits) -> Preset {
        match info.device_type {
            wgpu::DeviceType::Cpu => Preset::Low,
            _ if limits.max_texture_dimension_2d < 4096 => Preset::Low,
            wgpu::DeviceType::DiscreteGpu => Preset::High,
            _ => Preset::Medium,
        }
    }

    fn lower(self) -> Option<Preset> {
        match self {
            Preset::High => Some(Preset::Medium),
            Preset::Medium => Some(Preset::Low),
            Preset::Low => None,
        }
    }
}

/// Steps the preset down when the average frame stays over budget for a while. Never steps up on
/// its own: a preset that flips back and forth is worse than one slightly too low.
pub struct AutoTuner {
    budget_ms: f32,
    avg_ms: f32,
    over_for: f32,
}

impl AutoTuner {
    pub fn new(target_fps: f32) -> Self {
        Self { budget_ms: 1000.0 / target_fps * 1.15, avg_ms: 0.0, over_for: 0.0 }
    }

    /// Feed one frame's duration; returns a lower preset when it is time to step down.
    pub fn frame(&mut self, preset: Preset, frame_ms: f32) -> Option<Preset> {
        let frame_ms = frame_ms.min(250.0); // a pause or a resume is not a slow frame
        self.avg_ms = if self.avg_ms == 0.0 { frame_ms } else { self.avg_ms * 0.95 + frame_ms * 0.05 };
        if self.avg_ms > self.budget_ms {
            self.over_for += frame_ms / 1000.0;
        } else {
            self.over_for = 0.0;
        }
        if self.over_for > 3.0 {
            self.over_for = 0.0;
            self.avg_ms = 0.0;
            return preset.lower();
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steps_down_only_after_sustained_slow_frames() {
        let mut t = AutoTuner::new(60.0);
        for _ in 0..60 {
            assert_eq!(t.frame(Preset::High, 30.0), None); // one second of slow frames
        }
        let mut stepped = None;
        for _ in 0..200 {
            if let Some(p) = t.frame(Preset::High, 30.0) {
                stepped = Some(p);
                break;
            }
        }
        assert_eq!(stepped, Some(Preset::Medium));
    }

    #[test]
    fn fast_frames_and_pauses_never_step_down() {
        let mut t = AutoTuner::new(60.0);
        for i in 0..2000 {
            let ms = if i % 500 == 0 { 5000.0 } else { 10.0 };
            assert_eq!(t.frame(Preset::Medium, ms), None);
        }
    }

    #[test]
    fn low_is_the_floor() {
        assert_eq!(Preset::Low.lower(), None);
    }
}
