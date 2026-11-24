import { useGT } from "gt-react-native";

import { ListChoiceRow } from "../../components/ui/ListChoiceRow";

export function ProjectGitHubAccountChoices(props: {
  readonly accounts: ReadonlyArray<string>;
  readonly value: string | null;
  readonly mixed?: boolean;
  readonly disabled?: boolean;
  readonly description?: string;
  readonly onChange: (account: string | null) => void;
}) {
  const gt = useGT();
  const unavailable = props.value !== null && !props.accounts.includes(props.value);
  return (
    <>
      <ListChoiceRow
        label={gt("Use environment account")}
        description={props.description}
        selected={!props.mixed && props.value === null}
        disabled={props.disabled}
        onPress={() => props.onChange(null)}
      />
      {unavailable ? (
        <ListChoiceRow
          label={gt("{account} (unavailable)", { account: props.value })}
          selected
          separated
          disabled
          onPress={() => undefined}
        />
      ) : null}
      {props.accounts.map((account) => (
        <ListChoiceRow
          key={account}
          label={account}
          selected={props.value === account}
          separated
          disabled={props.disabled}
          onPress={() => props.onChange(account)}
        />
      ))}
    </>
  );
}
