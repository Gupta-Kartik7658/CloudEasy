import { useState, useEffect, useRef } from "react";
import { api, SSHKey, InboundRule } from "@/lib/api";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Loader2, CheckCircle2, Circle, Plus, X, Network } from "lucide-react";

interface CreateVMDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export const OS_IMAGES = [
  { value: "ubuntu/26.06", label: "Ubuntu 26.06" },
  { value: "ubuntu/noble64", label: "Ubuntu 24.04 (Noble)" },
  { value: "ubuntu/jammy64", label: "Ubuntu 22.04 (Jammy)" },
  { value: "ubuntu/focal64", label: "Ubuntu 20.04 (Focal)" },
  { value: "ubuntu/bionic64", label: "Ubuntu 18.04 (Bionic)" },
  { value: "debian/bullseye64", label: "Debian 11 (Bullseye)" },
  { value: "eurolinux-vagrant/centos-stream-8", label: "CentOS Stream 8" },
  { value: "eurolinux-vagrant/centos-stream-9", label: "CentOS Stream 9" },
];

export const CASUAL_PORT_PRESETS: Array<{
  port: number;
  type: InboundRule["type"];
  label: string;
  description: string;
}> = [
  { port: 22, type: "ssh", label: "SSH (22)", description: "SSH Access" },
  { port: 80, type: "http", label: "HTTP (80)", description: "HTTP Web Server" },
  { port: 443, type: "tcp", label: "HTTPS (443)", description: "HTTPS Secure Web" },
  { port: 3000, type: "http", label: "App (3000)", description: "Node / React Dev Server" },
  { port: 5000, type: "http", label: "API (5000)", description: "Flask / API Server" },
  { port: 5432, type: "tcp", label: "Postgres (5432)", description: "PostgreSQL Database" },
  { port: 8000, type: "http", label: "Web (8000)", description: "FastAPI / Django Server" },
  { port: 8080, type: "http", label: "HTTP Alt (8080)", description: "Web / Proxy Server" },
];

const DEFAULT_CASUAL_RULES: InboundRule[] = [
  { type: "ssh", vm_port: 22, description: "SSH Access" },
  { type: "http", vm_port: 80, description: "HTTP Web Server" },
  { type: "tcp", vm_port: 443, description: "HTTPS Secure Web" },
];

const CREATION_DURATION_MS = 27000;

const PROVISIONING_STEPS = [
  { threshold: 0, label: "Validating configuration & allocating private IP..." },
  { threshold: 20, label: "Downloading & initializing OS image..." },
  { threshold: 45, label: "Booting Virtual Machine resources (CPU & RAM)..." },
  { threshold: 70, label: "Injecting SSH keys & configuring casual network ports..." },
  { threshold: 90, label: "Establishing public FRP tunnels & finalizing instance..." },
];

export function CreateVMDialog({ open, onOpenChange, onSuccess }: CreateVMDialogProps) {
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [keys, setKeys] = useState<SSHKey[]>([]);
  const [inboundRules, setInboundRules] = useState<InboundRule[]>(DEFAULT_CASUAL_RULES);
  const [customPort, setCustomPort] = useState("");
  const [customDesc, setCustomDesc] = useState("");

  const [formData, setFormData] = useState({
    name: "",
    key_name: "",
    ram: "1024",
    cpu: "1",
    image: "ubuntu/26.06",
    provisioning_script: "",
  });

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (open) {
      loadKeys();
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [open]);

  const loadKeys = async () => {
    try {
      const data = await api.listKeys();
      setKeys(data);
      if (data.length > 0 && !formData.key_name) {
        setFormData((prev) => ({ ...prev, key_name: prev.key_name || data[0].name }));
      }
    } catch {
      toast.error("Failed to load SSH keys");
    }
  };

  const toggleCasualPort = (preset: (typeof CASUAL_PORT_PRESETS)[number]) => {
    if (preset.port === 22) {
      // Keep SSH port 22 always enabled so user can SSH into the VM
      return;
    }
    setInboundRules((prev) => {
      const exists = prev.some((r) => r.vm_port === preset.port);
      if (exists) {
        return prev.filter((r) => r.vm_port !== preset.port);
      }
      return [...prev, { type: preset.type, vm_port: preset.port, description: preset.description }];
    });
  };

  const handleAddCustomPort = () => {
    const portNum = parseInt(customPort, 10);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      toast.error("Port must be between 1 and 65535");
      return;
    }
    if (inboundRules.some((r) => r.vm_port === portNum)) {
      toast.error(`Port ${portNum} is already in the list`);
      return;
    }
    setInboundRules((prev) => [
      ...prev,
      {
        type: "tcp",
        vm_port: portNum,
        description: customDesc.trim() || `Custom Port ${portNum}`,
      },
    ]);
    setCustomPort("");
    setCustomDesc("");
    toast.success(`Port ${portNum} queued for VM`);
  };

  const removeQueuedPort = (portNum: number) => {
    if (portNum === 22) return;
    setInboundRules((prev) => prev.filter((r) => r.vm_port !== portNum));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // If user typed a port in the custom port box without clicking '+', include it automatically
    let finalRules = [...inboundRules];
    if (customPort.trim()) {
      const pendingPort = parseInt(customPort.trim(), 10);
      if (!isNaN(pendingPort) && pendingPort >= 1 && pendingPort <= 65535) {
        if (!finalRules.some((r) => r.vm_port === pendingPort)) {
          finalRules.push({
            type: "tcp",
            vm_port: pendingPort,
            description: customDesc.trim() || `Custom Port ${pendingPort}`,
          });
        }
      }
    }

    if (!formData.name.trim() || !formData.key_name) {
      toast.error("Please fill in all required fields");
      return;
    }

    setLoading(true);
    setProgress(2);
    setElapsedSeconds(0);

    const startTime = Date.now();
    timerRef.current = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const secs = Math.min(27, Math.floor(elapsed / 1000));
      const pct = Math.min(99, Math.round((elapsed / CREATION_DURATION_MS) * 100));
      setElapsedSeconds(secs);
      setProgress(pct);
    }, 250);

    try {
      const delayPromise = new Promise<void>((resolve) =>
        setTimeout(resolve, CREATION_DURATION_MS)
      );

      const createPromise = api.createVM({
        username: formData.name.trim(),
        key_name: formData.key_name,
        ram: parseInt(formData.ram, 10),
        cpu: parseInt(formData.cpu, 10),
        image: formData.image,
        inbound_rules: finalRules,
        provisioning_script: formData.provisioning_script || undefined,
      });

      // Wait for both API creation and the 27-second processing stage
      // If API fails early (e.g. duplicate name), surface error immediately without making user wait 27s
      const result = await createPromise;
      await delayPromise;

      setProgress(100);
      setElapsedSeconds(27);

      toast.success(`VM "${formData.name.trim()}" created and ready!`);
      if (result && typeof result === "object" && "message" in result) {
        toast.info(String(result.message), { duration: 10000 });
      }
      onSuccess();
      setFormData({
        name: "",
        key_name: keys[0]?.name || "",
        ram: "1024",
        cpu: "1",
        image: "ubuntu/26.06",
        provisioning_script: "",
      });
      setInboundRules(DEFAULT_CASUAL_RULES);
      setCustomPort("");
      setCustomDesc("");
    } catch (error: any) {
      toast.error(error.message || "Failed to create VM");
    } finally {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      setLoading(false);
      setProgress(0);
      setElapsedSeconds(0);
    }
  };

  const activeStepIndex = PROVISIONING_STEPS.reduce(
    (acc, step, idx) => (progress >= step.threshold ? idx : acc),
    0
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (loading) return; // Prevent accidental close while 27s provisioning is running
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {loading ? "Provisioning Virtual Machine..." : "Create Virtual Machine"}
          </DialogTitle>
          <DialogDescription>
            {loading
              ? `Setting up "${formData.name}" (${formData.image}) — please wait while resources are allocated`
              : "Configure your new VM instance"}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="py-6 space-y-6">
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2 font-medium text-foreground">
                <Loader2 className="w-4 h-4 animate-spin text-accent" />
                {PROVISIONING_STEPS[activeStepIndex]?.label}
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                {Math.max(0, 27 - elapsedSeconds)}s remaining ({progress}%)
              </span>
            </div>

            <Progress value={progress} className="h-2.5" />

            <div className="space-y-2.5 rounded-lg border border-border/50 bg-muted/30 p-4">
              {PROVISIONING_STEPS.map((step, index) => {
                const isDone = index < activeStepIndex || progress === 100;
                const isCurrent = index === activeStepIndex && progress < 100;
                return (
                  <div
                    key={step.label}
                    className={`flex items-center gap-2.5 text-sm transition-colors ${
                      isDone
                        ? "text-emerald-400"
                        : isCurrent
                        ? "text-foreground font-medium"
                        : "text-muted-foreground/60"
                    }`}
                  >
                    {isDone ? (
                      <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
                    ) : isCurrent ? (
                      <Loader2 className="w-4 h-4 shrink-0 animate-spin text-accent" />
                    ) : (
                      <Circle className="w-4 h-4 shrink-0 opacity-40" />
                    )}
                    <span>{step.label}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="name">VM Name *</Label>
                <Input
                  id="name"
                  placeholder="my-vm"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="key_name">SSH Key *</Label>
                <Select
                  value={formData.key_name}
                  onValueChange={(value) => setFormData({ ...formData, key_name: value })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select SSH key" />
                  </SelectTrigger>
                  <SelectContent>
                    {keys.length === 0 ? (
                      <div className="p-2 text-sm text-muted-foreground">
                        No SSH keys found. Create one first.
                      </div>
                    ) : (
                      keys.map((key) => (
                        <SelectItem key={key.name} value={key.name}>
                          {key.name}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="image">Operating System</Label>
              <Select
                value={formData.image}
                onValueChange={(value) => setFormData({ ...formData, image: value })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OS_IMAGES.map((img) => (
                    <SelectItem key={img.value} value={img.value}>
                      {img.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="cpu">CPU Cores</Label>
                <Input
                  id="cpu"
                  type="number"
                  min="1"
                  max="4"
                  value={formData.cpu}
                  onChange={(e) => setFormData({ ...formData, cpu: e.target.value })}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="ram">RAM (MB)</Label>
                <Input
                  id="ram"
                  type="number"
                  min="256"
                  step="256"
                  value={formData.ram}
                  onChange={(e) => setFormData({ ...formData, ram: e.target.value })}
                />
              </div>
            </div>

            {/* Casual & Custom Inbound Ports */}
            <div className="space-y-3 rounded-lg border border-border/50 bg-muted/20 p-3.5">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-1.5 text-sm">
                  <Network className="w-4 h-4 text-accent" />
                  Inbound Ports (Casual & Custom)
                </Label>
                <span className="text-xs text-muted-foreground">
                  {inboundRules.length} active
                </span>
              </div>

              <div className="flex flex-wrap gap-1.5">
                {CASUAL_PORT_PRESETS.map((preset) => {
                  const selected = inboundRules.some((r) => r.vm_port === preset.port);
                  return (
                    <button
                      key={preset.port}
                      type="button"
                      onClick={() => toggleCasualPort(preset)}
                      className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
                        selected
                          ? "bg-accent/20 text-accent border-accent/60"
                          : "bg-card text-muted-foreground border-border/50 hover:border-border hover:text-foreground"
                      } ${preset.port === 22 ? "cursor-default" : "cursor-pointer"}`}
                      title={preset.port === 22 ? "SSH Port 22 is always enabled" : preset.description}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>

              {/* Custom port adder */}
              <div className="flex gap-2 pt-1">
                <Input
                  type="number"
                  placeholder="Port (e.g. 9000)"
                  value={customPort}
                  onChange={(e) => setCustomPort(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleAddCustomPort();
                    }
                  }}
                  min={1}
                  max={65535}
                  className="h-8 w-36 text-xs"
                />
                <Input
                  type="text"
                  placeholder="Description (e.g. Custom service)"
                  value={customDesc}
                  onChange={(e) => setCustomDesc(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleAddCustomPort();
                    }
                  }}
                  className="h-8 flex-1 text-xs"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={handleAddCustomPort}
                  className="h-8 px-2.5 text-xs"
                >
                  <Plus className="w-3.5 h-3.5 mr-1" />
                  Add Port
                </Button>
              </div>

              {inboundRules.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {inboundRules.map((rule) => (
                    <Badge
                      key={rule.vm_port}
                      variant="secondary"
                      className="flex items-center gap-1 text-xs font-normal"
                    >
                      <span>
                        {rule.type.toUpperCase()} :{rule.vm_port}
                        {rule.description ? ` (${rule.description})` : ""}
                      </span>
                      {rule.vm_port !== 22 && (
                        <button
                          type="button"
                          onClick={() => removeQueuedPort(rule.vm_port)}
                          className="ml-0.5 hover:text-destructive"
                          aria-label={`Remove port ${rule.vm_port}`}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </Badge>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="script">Provisioning Script (Optional)</Label>
              <Textarea
                id="script"
                placeholder="apt-get update&#10;apt-get install -y nginx"
                value={formData.provisioning_script}
                onChange={(e) => setFormData({ ...formData, provisioning_script: e.target.value })}
                rows={4}
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Bash script to run after VM creation. Will execute as the VM user.
              </p>
            </div>

            <div className="flex justify-end gap-2 pt-4">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={loading} className="gradient-primary">
                Create VM
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
