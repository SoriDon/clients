import { BehaviorSubject, combineLatest, concatMap, map, Observable, of } from "rxjs";

import { ListResponse } from "../../../models/response/list.response";
import { StateService } from "../../../platform/abstractions/state.service";
import { Utils } from "../../../platform/misc/utils";
import { KeyDefinition, POLICIES_DISK, StateProvider } from "../../../platform/state";
import { PolicyId, UserId } from "../../../types/guid";
import { OrganizationService } from "../../abstractions/organization/organization.service.abstraction";
import { InternalPolicyService as InternalPolicyServiceAbstraction } from "../../abstractions/policy/policy.service.abstraction";
import { OrganizationUserStatusType, PolicyType } from "../../enums";
import { PolicyData } from "../../models/data/policy.data";
import { MasterPasswordPolicyOptions } from "../../models/domain/master-password-policy-options";
import { Organization } from "../../models/domain/organization";
import { Policy } from "../../models/domain/policy";
import { ResetPasswordPolicyOptions } from "../../models/domain/reset-password-policy-options";
import { PolicyResponse } from "../../models/response/policy.response";

const policyRecordToArray = (policiesMap: { [id: string]: PolicyData }) =>
  Object.values(policiesMap || {}).map((f) => new Policy(f));

export const POLICIES = KeyDefinition.record<PolicyData, PolicyId>(POLICIES_DISK, "policies", {
  deserializer: (policyData) => policyData,
});

export class PolicyService implements InternalPolicyServiceAbstraction {
  protected _policies: BehaviorSubject<Policy[]> = new BehaviorSubject([]);

  policies$ = this._policies.asObservable();

  private activeUserPolicyState = this.stateProvider.getActive(POLICIES);
  activeUserPolicies$ = this.activeUserPolicyState.state$.pipe(
    map((policyData) => policyRecordToArray(policyData)),
  );

  constructor(
    protected stateService: StateService,
    private stateProvider: StateProvider,
    private organizationService: OrganizationService,
  ) {
    this.stateService.activeAccountUnlocked$
      .pipe(
        concatMap(async (unlocked) => {
          if (Utils.global.bitwardenContainerService == null) {
            return;
          }

          if (!unlocked) {
            this._policies.next([]);
            return;
          }

          const data = await this.stateService.getEncryptedPolicies();

          await this.updateObservables(data);
        }),
      )
      .subscribe();
  }

  // --- StateProvider methods - not yet wired up
  get_vNext$(policyType: PolicyType) {
    const filteredPolicies$ = this.activeUserPolicies$.pipe(
      map((policies) => policies.filter((p) => p.type === policyType)),
    );

    return combineLatest([filteredPolicies$, this.organizationService.organizations$]).pipe(
      map(
        ([policies, organizations]) =>
          this.enforcedPolicyFilter(policies, organizations)?.at(0) ?? null,
      ),
    );
  }

  getAll_vNext$(policyType: PolicyType, userId?: UserId) {
    const filteredPolicies$ = this.stateProvider.getUserState$(POLICIES, userId).pipe(
      map((policyData) => policyRecordToArray(policyData)),
      map((policies) => policies.filter((p) => p.type === policyType)),
    );

    return combineLatest([filteredPolicies$, this.organizationService.organizations$]).pipe(
      map(([policies, organizations]) => this.enforcedPolicyFilter(policies, organizations)),
    );
  }

  policyAppliesToActiveUser_vNext$(policyType: PolicyType) {
    return this.get_vNext$(policyType).pipe(map((policy) => policy != null));
  }

  private enforcedPolicyFilter(policies: Policy[], organizations: Organization[]) {
    const orgDict = Object.fromEntries(organizations.map((o) => [o.id, o]));
    return policies.filter((policy) => {
      const organization = orgDict[policy.organizationId];

      // This shouldn't happen, i.e. the user should only have policies for orgs they are a member of
      // But if it does, err on the side of enforcing the policy
      if (organization == null) {
        return true;
      }

      return (
        policy.enabled &&
        organization.status >= OrganizationUserStatusType.Accepted &&
        organization.usePolicies &&
        !this.isExemptFromPolicy(policy.type, organization)
      );
    });
  }
  // --- End StateProvider methods

  get$(policyType: PolicyType, policyFilter?: (policy: Policy) => boolean): Observable<Policy> {
    return this.policies$.pipe(
      concatMap(async (policies) => {
        const userId = await this.stateService.getUserId();
        const appliesToCurrentUser = await this.checkPoliciesThatApplyToUser(
          policies,
          policyType,
          policyFilter,
          userId,
        );
        if (appliesToCurrentUser) {
          return policies.find((policy) => policy.type === policyType && policy.enabled);
        }
      }),
    );
  }

  async getAll(type?: PolicyType, userId?: string): Promise<Policy[]> {
    let response: Policy[] = [];
    const decryptedPolicies = await this.stateService.getDecryptedPolicies({ userId: userId });
    if (decryptedPolicies != null) {
      response = decryptedPolicies;
    } else {
      const diskPolicies = await this.stateService.getEncryptedPolicies({ userId: userId });
      for (const id in diskPolicies) {
        if (Object.prototype.hasOwnProperty.call(diskPolicies, id)) {
          response.push(new Policy(diskPolicies[id]));
        }
      }
      await this.stateService.setDecryptedPolicies(response, { userId: userId });
    }
    if (type != null) {
      return response.filter((policy) => policy.type === type);
    } else {
      return response;
    }
  }

  masterPasswordPolicyOptions$(policies?: Policy[]): Observable<MasterPasswordPolicyOptions> {
    const observable = policies ? of(policies) : this.policies$;
    return observable.pipe(
      map((obsPolicies) => {
        let enforcedOptions: MasterPasswordPolicyOptions = null;
        const filteredPolicies = obsPolicies.filter((p) => p.type === PolicyType.MasterPassword);

        if (filteredPolicies == null || filteredPolicies.length === 0) {
          return enforcedOptions;
        }

        filteredPolicies.forEach((currentPolicy) => {
          if (!currentPolicy.enabled || currentPolicy.data == null) {
            return;
          }

          if (enforcedOptions == null) {
            enforcedOptions = new MasterPasswordPolicyOptions();
          }

          if (
            currentPolicy.data.minComplexity != null &&
            currentPolicy.data.minComplexity > enforcedOptions.minComplexity
          ) {
            enforcedOptions.minComplexity = currentPolicy.data.minComplexity;
          }

          if (
            currentPolicy.data.minLength != null &&
            currentPolicy.data.minLength > enforcedOptions.minLength
          ) {
            enforcedOptions.minLength = currentPolicy.data.minLength;
          }

          if (currentPolicy.data.requireUpper) {
            enforcedOptions.requireUpper = true;
          }

          if (currentPolicy.data.requireLower) {
            enforcedOptions.requireLower = true;
          }

          if (currentPolicy.data.requireNumbers) {
            enforcedOptions.requireNumbers = true;
          }

          if (currentPolicy.data.requireSpecial) {
            enforcedOptions.requireSpecial = true;
          }

          if (currentPolicy.data.enforceOnLogin) {
            enforcedOptions.enforceOnLogin = true;
          }
        });

        return enforcedOptions;
      }),
    );
  }

  policyAppliesToActiveUser$(policyType: PolicyType, policyFilter?: (policy: Policy) => boolean) {
    return this.policies$.pipe(
      concatMap(async (policies) => {
        const userId = await this.stateService.getUserId();
        return await this.checkPoliciesThatApplyToUser(policies, policyType, policyFilter, userId);
      }),
    );
  }

  evaluateMasterPassword(
    passwordStrength: number,
    newPassword: string,
    enforcedPolicyOptions: MasterPasswordPolicyOptions,
  ): boolean {
    if (enforcedPolicyOptions == null) {
      return true;
    }

    if (
      enforcedPolicyOptions.minComplexity > 0 &&
      enforcedPolicyOptions.minComplexity > passwordStrength
    ) {
      return false;
    }

    if (
      enforcedPolicyOptions.minLength > 0 &&
      enforcedPolicyOptions.minLength > newPassword.length
    ) {
      return false;
    }

    if (enforcedPolicyOptions.requireUpper && newPassword.toLocaleLowerCase() === newPassword) {
      return false;
    }

    if (enforcedPolicyOptions.requireLower && newPassword.toLocaleUpperCase() === newPassword) {
      return false;
    }

    if (enforcedPolicyOptions.requireNumbers && !/[0-9]/.test(newPassword)) {
      return false;
    }

    // eslint-disable-next-line
    if (enforcedPolicyOptions.requireSpecial && !/[!@#$%\^&*]/g.test(newPassword)) {
      return false;
    }

    return true;
  }

  getResetPasswordPolicyOptions(
    policies: Policy[],
    orgId: string,
  ): [ResetPasswordPolicyOptions, boolean] {
    const resetPasswordPolicyOptions = new ResetPasswordPolicyOptions();

    if (policies == null || orgId == null) {
      return [resetPasswordPolicyOptions, false];
    }

    const policy = policies.find(
      (p) => p.organizationId === orgId && p.type === PolicyType.ResetPassword && p.enabled,
    );
    resetPasswordPolicyOptions.autoEnrollEnabled = policy?.data?.autoEnrollEnabled ?? false;

    return [resetPasswordPolicyOptions, policy?.enabled ?? false];
  }

  mapPolicyFromResponse(policyResponse: PolicyResponse): Policy {
    const policyData = new PolicyData(policyResponse);
    return new Policy(policyData);
  }

  mapPoliciesFromToken(policiesResponse: ListResponse<PolicyResponse>): Policy[] {
    if (policiesResponse?.data == null) {
      return null;
    }

    return policiesResponse.data.map((response) => this.mapPolicyFromResponse(response));
  }

  async policyAppliesToUser(
    policyType: PolicyType,
    policyFilter?: (policy: Policy) => boolean,
    userId?: string,
  ) {
    const policies = await this.getAll(policyType, userId);

    return this.checkPoliciesThatApplyToUser(policies, policyType, policyFilter, userId);
  }

  async upsert(policy: PolicyData): Promise<any> {
    let policies = await this.stateService.getEncryptedPolicies();
    if (policies == null) {
      policies = {};
    }

    policies[policy.id] = policy;

    await this.updateObservables(policies);
    await this.stateService.setDecryptedPolicies(null);
    await this.stateService.setEncryptedPolicies(policies);
  }

  async replace(policies: { [id: string]: PolicyData }): Promise<void> {
    await this.updateObservables(policies);
    await this.stateService.setDecryptedPolicies(null);
    await this.stateService.setEncryptedPolicies(policies);
  }

  async clear(userId?: string): Promise<void> {
    if (userId == null || userId == (await this.stateService.getUserId())) {
      this._policies.next([]);
    }
    await this.stateService.setDecryptedPolicies(null, { userId: userId });
    await this.stateService.setEncryptedPolicies(null, { userId: userId });
  }

  private async updateObservables(policiesMap: { [id: string]: PolicyData }) {
    const policies = Object.values(policiesMap || {}).map((f) => new Policy(f));

    this._policies.next(policies);
  }

  private async checkPoliciesThatApplyToUser(
    policies: Policy[],
    policyType: PolicyType,
    policyFilter?: (policy: Policy) => boolean,
    userId?: string,
  ) {
    const organizations = await this.organizationService.getAll(userId);
    const filteredPolicies = policies.filter(
      (p) => p.type === policyType && p.enabled && (policyFilter == null || policyFilter(p)),
    );
    const policySet = new Set(filteredPolicies.map((p) => p.organizationId));

    return organizations.some(
      (o) =>
        o.status >= OrganizationUserStatusType.Accepted &&
        o.usePolicies &&
        policySet.has(o.id) &&
        !this.isExemptFromPolicy(policyType, o),
    );
  }

  /**
   * Determines whether an orgUser is exempt from a specific policy because of their role
   * Generally orgUsers who can manage policies are exempt from them, but some policies are stricter
   */
  private isExemptFromPolicy(policyType: PolicyType, organization: Organization) {
    switch (policyType) {
      case PolicyType.MaximumVaultTimeout:
        // Max Vault Timeout applies to everyone except owners
        return organization.isOwner;
      default:
        return organization.canManagePolicies;
    }
  }
}
