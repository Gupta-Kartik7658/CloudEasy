import { useState, useEffect } from "react";
import { api, VM, InboundRule } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Plus, Trash2, Network, Loader2 } from "lucide-react";

interface NetworkRulesSectionProps {
  vm: VM;
  onUpdate: () => void;
  onRulesChanged?: (rules: InboundRule[]) => void;
}

const CASUAL_PORTS: Array<{
  port: number;
  type: InboundRule["type"];
  label: string;
  description: string;
}> = [
  { port: 80, type: "http", label: "HTTP (80)", description: "HTTP Web Server" },
  { port: 443, type: "tcp", label: "HTTPS (443)", description: "HTTPS Secure Web" },
  { port: 3000, type: "http", label: "3000", description: "Node / Web App" },
  { port: 5000, type: "http", label: "5000", description: "API Server" },
  { port: 5432, type: "tcp", label: "5432", description: "PostgreSQL" },
  { port: 8000, type: "http", label: "8000", description: "FastAPI / Backend" },
  { port: 8080, type: "http", label: "8080", description: "Web Server" },
];

export function NetworkRulesSection({ vm, onUpdate, onRulesChanged }: NetworkRulesSectionProps) {
  const [rules, setRules] = useState<InboundRule[]>(vm.inbound_rules || []);
  const [newPort, setNewPort] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setRules(vm.inbound_rules || []);
  }, [vm.inbound_rules]);

  const updateLocalRules = (nextRules: InboundRule[]) => {
    setRules(nextRules);
    onRulesChanged?.(nextRules);
  };

  const addPortRule = async (
    port: number,
    description: string,
    ruleType: InboundRule["type"] = "tcp"
  ) => {
    if (isNaN(port) || port < 1 || port > 65535) {
      toast.error("Port must be between 1 and 65535");
      return;
    }

    if (rules.some((r) => Number(r.vm_port) === port)) {
      toast.info(`Port ${port} is already added`);
      return;
    }

    const finalDesc = description.trim() || `Port ${port}`;
    setLoading(true);
    try {
      const response: any = await api.addInboundRule(port, vm.name, finalDesc, ruleType);
      const createdRule: InboundRule = response?.rule || {
        type: ruleType,
        vm_port: port,
        description: finalDesc,
        remotePort: response?.remotePort,
      };

      // Optimistically update the displayed rules immediately so the added port always shows right away
      updateLocalRules([...rules, createdRule]);
      toast.success(`Rule for port ${port} added`);
      setNewPort("");
      setNewDescription("");
      onUpdate();
    } catch (error: any) {
      toast.error(error.message || "Failed to add rule");
    } finally {
      setLoading(false);
    }
  };

  const handleAddRule = async (e: React.FormEvent) => {
    e.preventDefault();
    const port = parseInt(newPort, 10);
    await addPortRule(port, newDescription, "tcp");
  };

  const handleRemoveRule = async (rule: InboundRule) => {
    const labelPort = rule.remotePort || rule.vm_port;
    if (!confirm(`Remove rule for port ${rule.vm_port}${rule.remotePort ? ` (public ${rule.remotePort})` : ""}?`)) {
      return;
    }

    setLoading(true);
    try {
      await api.removeInboundRule(vm.name, rule.remotePort || 0, rule.vm_port);
      updateLocalRules(
        rules.filter(
          (r) =>
            !(
              r.vm_port === rule.vm_port &&
              (r.remotePort ?? null) === (rule.remotePort ?? null)
            )
        )
      );
      toast.success(`Rule for port ${labelPort} removed`);
      onUpdate();
    } catch (error: any) {
      toast.error(error.message || "Failed to remove rule");
    } finally {
      setLoading(false);
    }
  };

  const availableCasualPorts = CASUAL_PORTS.filter(
    (preset) => !rules.some((r) => Number(r.vm_port) === preset.port)
  );

  return (
    <div className="space-y-3 p-3 bg-muted/30 rounded-lg border border-border/50">
      <div className="space-y-2">
        {rules.map((rule, index) => (
          <div
            key={`${rule.vm_port}-${rule.remotePort ?? index}`}
            className="flex items-center justify-between p-2 bg-card rounded border border-border/30"
          >
            <div className="flex items-center gap-2 flex-1">
              <Network className="w-4 h-4 text-accent" />
              <div className="flex-1">
                <p className="text-sm font-medium">
                  {(rule.type || "tcp").toUpperCase()} - Port {rule.vm_port}
                  {rule.remotePort ? ` → ${rule.remotePort}` : ""}
                </p>
                {rule.description && (
                  <p className="text-xs text-muted-foreground">{rule.description}</p>
                )}
              </div>
            </div>
            {rule.vm_port !== 22 && (
              <Button
                type="button"
                onClick={() => handleRemoveRule(rule)}
                disabled={loading}
                size="sm"
                variant="ghost"
                className="h-8 w-8 p-0 text-destructive hover:text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            )}
          </div>
        ))}
      </div>

      {/* Quick casual ports row */}
      {availableCasualPorts.length > 0 && (
        <div className="space-y-1.5 pt-2 border-t border-border/30">
          <p className="text-[11px] text-muted-foreground">Quick add casual ports:</p>
          <div className="flex flex-wrap gap-1.5">
            {availableCasualPorts.map((preset) => (
              <button
                key={preset.port}
                type="button"
                disabled={loading}
                onClick={() => addPortRule(preset.port, preset.description, preset.type)}
                className="px-2 py-0.5 rounded text-xs border border-border/60 bg-card hover:border-accent/60 hover:bg-accent/10 hover:text-accent transition-colors disabled:opacity-50"
                title={`Add ${preset.description}`}
              >
                + {preset.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <form onSubmit={handleAddRule} className="space-y-3 pt-2 border-t border-border/30">
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label htmlFor={`port-${vm.id}`} className="text-xs">
              VM Port
            </Label>
            <Input
              id={`port-${vm.id}`}
              type="number"
              placeholder="8080"
              value={newPort}
              onChange={(e) => setNewPort(e.target.value)}
              min={1}
              max={65535}
              required
              className="h-8"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`desc-${vm.id}`} className="text-xs">
              Description
            </Label>
            <Input
              id={`desc-${vm.id}`}
              type="text"
              placeholder="Web server"
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              className="h-8"
            />
          </div>
        </div>
        <Button type="submit" disabled={loading} size="sm" className="w-full" variant="outline">
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Adding...
            </>
          ) : (
            <>
              <Plus className="w-4 h-4 mr-2" />
              Add Rule
            </>
          )}
        </Button>
      </form>
    </div>
  );
}
