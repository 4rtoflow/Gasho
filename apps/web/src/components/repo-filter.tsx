// The repository the sidebar's worktrees are narrowed to, picked from a menu at the right of their title. The menu also
// opens the dialog that registers repositories with a working server (repos-dialog).
import { Check, FolderGit2, ListFilter } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useRef } from "react";
import { MENU, MENU_ITEM } from "@/components/dialog-styles";
import { SECTION_BUTTON } from "@/components/ui/sidebar";
import type { RepoChoice } from "@/lib/sessions";
import { cn } from "@/lib/utils";

const ALL = "";

export function RepoFilter({
  choices,
  picked,
  onPick,
  onRegister,
  machineNames,
}: {
  choices: RepoChoice[];
  /** The repository the worktrees are narrowed to; undefined: all of them. */
  picked: RepoChoice | undefined;
  onPick: (key: string | undefined) => void;
  onRegister: () => void;
  /** Name each repository's working server too (there are several). */
  machineNames: boolean;
}) {
  // Focus goes back to the button when the menu closes, unless the dialog is opening from it.
  const registering = useRef(false);
  const label = picked ? `リポジトリで絞り込む（${picked.name}）` : "リポジトリで絞り込む";
  return (
    <DropdownMenu.Root
      onOpenChange={(open) => {
        if (open) registering.current = false;
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button type="button" aria-label={label} title={label} className={cn(SECTION_BUTTON, picked && "text-neutral-900 dark:text-white")}>
          <ListFilter />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          collisionPadding={8}
          className={MENU}
          onCloseAutoFocus={(e) => {
            if (registering.current) e.preventDefault();
          }}
        >
          <DropdownMenu.Label className="px-2.5 pt-1 pb-1.5 text-xs text-muted-foreground">リポジトリで絞り込む</DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={picked?.key ?? ALL} onValueChange={(v) => onPick(v === ALL ? undefined : v)}>
            <DropdownMenu.RadioItem value={ALL} className={MENU_ITEM}>
              <span className="min-w-0 flex-1 truncate">すべて</span>
              <DropdownMenu.ItemIndicator>
                <Check className="size-4" />
              </DropdownMenu.ItemIndicator>
            </DropdownMenu.RadioItem>
            {choices.map((c) => (
              <DropdownMenu.RadioItem key={c.key} value={c.key} className={MENU_ITEM}>
                <span className="min-w-0 flex-1 truncate">
                  {c.name}
                  {machineNames && <span className="text-xs text-muted-foreground"> · {c.machine.name}</span>}
                </span>
                <DropdownMenu.ItemIndicator>
                  <Check className="size-4" />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item
            onSelect={() => {
              registering.current = true;
              onRegister();
            }}
            className={cn(MENU_ITEM, "[&>svg]:text-muted-foreground")}
          >
            <FolderGit2 />
            リポジトリを登録・解除…
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
