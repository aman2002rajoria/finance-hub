"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  cancelCategorizationJob,
  getActiveCategorizationJob,
  getCategorizationJob,
  startCategorizationJob,
  type CategorizationJob,
} from "@/lib/api";
import { isJobRunning, isJobTerminal } from "@/lib/categorization-status";

type Mode = "unclassified" | "reclassify_all";

export function useCategorizationJob(opts?: {
  onFinished?: (job: CategorizationJob) => void;
}) {
  const [job, setJob] = useState<CategorizationJob | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [terminating, setTerminating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const finishedRef = useRef<string | null>(null);
  const onFinishedRef = useRef(opts?.onFinished);
  onFinishedRef.current = opts?.onFinished;

  const running = isJobRunning(job);
  const terminal = isJobTerminal(job);

  // Resume tracking if a job is already running (banner only — don't force dialog open).
  useEffect(() => {
    getActiveCategorizationJob()
      .then(active => {
        if (active && isJobRunning(active)) setJob(active);
      })
      .catch(() => {});
  }, []);

  // Poll progress regardless of dialog visibility.
  useEffect(() => {
    if (!job?.job_id || !running) return;
    const poll = async () => {
      try {
        const updated = await getCategorizationJob(job.job_id);
        setJob(updated);
      } catch { /* ignore transient poll errors */ }
    };
    poll();
    const id = setInterval(poll, 800);
    return () => clearInterval(id);
  }, [job?.job_id, running]);

  // Fire finish callback once per job.
  useEffect(() => {
    if (!job || !terminal) return;
    if (finishedRef.current === job.job_id) return;
    finishedRef.current = job.job_id;
    onFinishedRef.current?.(job);
  }, [job, terminal]);

  const startJob = useCallback(async (mode: Mode) => {
    setStarting(true);
    setError(null);
    setDialogOpen(true);
    try {
      const started = await startCategorizationJob(mode);
      finishedRef.current = null;
      setJob(started);
    } catch (e) {
      setError(String(e));
      setDialogOpen(false);
      throw e;
    } finally {
      setStarting(false);
    }
  }, []);

  const cancelJob = useCallback(async () => {
    if (!job?.job_id || terminating) return;
    setTerminating(true);
    try {
      const updated = await cancelCategorizationJob(job.job_id);
      if (updated) setJob(updated);
    } catch (e) {
      setError(String(e));
    } finally {
      setTerminating(false);
    }
  }, [job?.job_id, terminating]);

  const closeDialog = useCallback(() => setDialogOpen(false), []);
  const openDialog = useCallback(() => setDialogOpen(true), []);

  return {
    job,
    running,
    terminal,
    starting,
    terminating,
    error,
    dialogOpen,
    setDialogOpen,
    closeDialog,
    openDialog,
    startJob,
    cancelJob,
    clearError: () => setError(null),
  };
}
