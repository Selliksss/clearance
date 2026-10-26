// Rolling spending window of 24 buckets. Pure logic with no env calls, so it is
// property-tested natively. Guarantee: accepted spends inside any 23-hour
// interval sum to at most the cap (a spend early in a bucket leaves the window
// 23h+ later, so two full caps need more than 23h between them).
use near_sdk::near;

pub const BUCKETS: usize = 24;
const EMPTY: u64 = u64::MAX;

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Buckets {
    // (bucket id, amount); slot index = bucket id % 24. Always 24 slots, so a
    // vault's storage size never grows after creation.
    slots: Vec<(u64, u128)>,
}

impl Default for Buckets {
    fn default() -> Self {
        Self {
            slots: vec![(EMPTY, 0); BUCKETS],
        }
    }
}

impl Buckets {
    /// Sum of the current bucket and the 23 before it.
    pub fn window_sum(&self, now: u64) -> u128 {
        self.slots
            .iter()
            .filter(|(b, _)| *b != EMPTY && *b <= now && b.saturating_add(BUCKETS as u64) > now)
            .fold(0u128, |acc, (_, a)| acc.saturating_add(*a))
    }

    pub fn record(&mut self, now: u64, amount: u128) {
        let slot = &mut self.slots[(now % BUCKETS as u64) as usize];
        if slot.0 != now {
            *slot = (now, 0);
        }
        slot.1 = slot.1.saturating_add(amount);
    }

    /// Undo a recorded spend only if its bucket is still in place.
    pub fn unrecord(&mut self, bucket: u64, amount: u128) {
        let slot = &mut self.slots[(bucket % BUCKETS as u64) as usize];
        if slot.0 == bucket {
            slot.1 = slot.1.saturating_sub(amount);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const H: u64 = 3_600_000_000_000;

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(2000))]
        #[test]
        fn any_23h_interval_within_cap(
            steps in prop::collection::vec((0u64..(6 * H), 1u128..=5), 1..120),
            cap in 1u128..=10,
        ) {
            let mut b = Buckets::default();
            let mut t = 0u64;
            let mut accepted: Vec<(u64, u128)> = vec![];
            for (dt, amt) in steps {
                t += dt;
                let now = t / H;
                if b.window_sum(now) + amt <= cap {
                    b.record(now, amt);
                    accepted.push((t, amt));
                }
            }
            for (start, _) in &accepted {
                let end = start + 23 * H;
                let sum: u128 = accepted.iter().filter(|(s, _)| s >= start && *s < end).map(|(_, a)| a).sum();
                prop_assert!(sum <= cap, "sum {} > cap {} in [{}, {})", sum, cap, start, end);
            }
        }

        #[test]
        fn unrecord_same_bucket_restores(amt in 1u128..1000, other in 0u128..1000, now in 0u64..10_000) {
            let mut b = Buckets::default();
            b.record(now, other);
            let before = b.window_sum(now);
            b.record(now, amt);
            b.unrecord(now, amt);
            prop_assert_eq!(b.window_sum(now), before);
        }
    }

    #[test]
    fn unrecord_after_rotation_is_noop() {
        let mut b = Buckets::default();
        b.record(0, 5);
        b.record(24, 3);
        b.unrecord(0, 5);
        assert_eq!(b.window_sum(24), 3);
    }

    #[test]
    fn spend_leaves_window_after_24_buckets() {
        let mut b = Buckets::default();
        b.record(10, 7);
        assert_eq!(b.window_sum(33), 7);
        assert_eq!(b.window_sum(34), 0);
    }
}
