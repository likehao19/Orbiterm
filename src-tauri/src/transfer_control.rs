use std::sync::{Condvar, Mutex};

#[derive(Default)]
pub(crate) struct TransferControl {
    state: Mutex<(bool, bool)>, // cancelled, paused
    changed: Condvar,
}

impl TransferControl {
    pub(crate) fn checkpoint(&self) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| "传输状态已损坏")?;
        while state.1 && !state.0 {
            state = self.changed.wait(state).map_err(|_| "传输状态已损坏")?;
        }
        if state.0 { Err("传输已取消".to_string()) } else { Ok(()) }
    }

    pub(crate) fn pause(&self, paused: bool) -> Result<(), String> {
        self.state.lock().map_err(|_| "传输状态已损坏")?.1 = paused;
        self.changed.notify_all();
        Ok(())
    }

    pub(crate) fn cancel(&self) -> Result<(), String> {
        self.state.lock().map_err(|_| "传输状态已损坏")?.0 = true;
        self.changed.notify_all();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::{mpsc, Arc}, thread, time::Duration};

    #[test]
    fn pause_blocks_until_resume_without_losing_the_worker() {
        let control = Arc::new(TransferControl::default());
        control.pause(true).unwrap();
        let (tx, rx) = mpsc::channel();
        let worker = control.clone();
        let handle = thread::spawn(move || tx.send(worker.checkpoint()).unwrap());
        assert!(rx.recv_timeout(Duration::from_millis(50)).is_err());
        control.pause(false).unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(1)).unwrap(), Ok(()));
        handle.join().unwrap();
    }

    #[test]
    fn cancel_wakes_a_paused_transfer() {
        let control = Arc::new(TransferControl::default());
        control.pause(true).unwrap();
        let (tx, rx) = mpsc::channel();
        let worker = control.clone();
        let handle = thread::spawn(move || tx.send(worker.checkpoint()).unwrap());
        control.cancel().unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(1)).unwrap(), Err("传输已取消".into()));
        handle.join().unwrap();
        assert!(TransferControl::default().checkpoint().is_ok());
    }
}
