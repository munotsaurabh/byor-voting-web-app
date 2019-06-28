import { Component, ViewChild, ElementRef, AfterViewInit, OnDestroy } from '@angular/core';
import { Router } from '@angular/router';
import { MatDialog } from '@angular/material';

import { BehaviorSubject, combineLatest, Observable, fromEvent, concat, of, Subject, merge, EMPTY, Subscription } from 'rxjs';
import { map, catchError, switchMap, scan, shareReplay, delay, tap } from 'rxjs/operators';

import { environment } from '../../../../environments/environment';

import { VoteDialogueComponent } from './vote-dialogue.component';
import { VoteSavedDialogueComponent } from './vote-saved-dialogue.component';

import { BackendService } from '../../../services/backend.service';
import { ErrorService } from '../../../services/error.service';
import { Technology } from '../../../models/technology';
import { Vote } from '../../../models/vote';
import { QUADRANT_NAMES } from '../../../models/quadrant';
import { VoteService } from '../services/vote.service';
import { VoteCredentials } from '../../../models/vote-credentials';
import * as _ from 'lodash';
import { TwRings } from 'src/app/models/ring';
import { Comment } from 'src/app/models/comment';
import { logError } from 'src/app/utils/utils';

@Component({
  selector: 'byor-vote',
  templateUrl: './vote.component.html',
  styleUrls: ['./vote.component.scss']
})
export class VoteComponent implements AfterViewInit, OnDestroy {
  @ViewChild('searchField') searchField: ElementRef;
  quadrants = QUADRANT_NAMES;
  rings = TwRings.names;

  private technologiesToShowSubscription: Subscription;
  technologiesToShow: Technology[];

  votes = new Array<Vote>();
  votes$ = new BehaviorSubject<Array<Vote>>(this.votes);
  search$: Observable<any>;
  clearSearch$ = new Subject<any>();
  quadrantSelected$ = new BehaviorSubject<string>('');
  // the following Observable emits the name of the quadrant selected if it is different from the last quadrant selected,
  // otherwise, if it is the same value as the last one selected, it emits an empty string
  // this is to implement a toggle mechanism, so that if you click twice on the same button, the first time it emits
  // the name of the quadrant associated to the button while the second time it emits the empty string - the third time it
  // would emit again the name of the quadrant
  // via this mechanims we can avoid defining a Class variable to hold the state of the "selected button" and we keep
  // the implementation stateless - to be understood whether this makes it simpler
  quadrantSelectedToggle$ = this.quadrantSelected$.pipe(
    scan((currentQuadrant, quadrant) => {
      return currentQuadrant === quadrant ? '' : quadrant;
    }),
    // shareReplay(1) is important since this Observable is used with 2 subscriptions: one to support the filtering
    // and one to support the highlight of the selected quadrant button with toggling
    shareReplay(1)
  );

  votingEventId$: Observable<any>;

  messageVote: string;

  constructor(
    private backEnd: BackendService,
    private router: Router,
    private errorService: ErrorService,
    public dialog: MatDialog,
    private voteService: VoteService
  ) {}

  ngAfterViewInit() {
    this.search$ = merge(concat(of(''), fromEvent(this.searchField.nativeElement, 'keyup')), this.clearSearch$).pipe(
      map(() => this.searchField.nativeElement.value)
    );
    this.technologiesToShowSubscription = this.techonologiesToShow().subscribe((t) => {
      this.technologiesToShow = t;
    });
  }
  ngOnDestroy() {
    if (!!this.technologiesToShowSubscription) {
      this.technologiesToShowSubscription.unsubscribe();
    }
  }

  techonologiesToShow() {
    let technologies: Array<Technology>;
    return this.getTechnologies().pipe(
      tap((techs) => (technologies = techs)),
      switchMap(() => {
        return combineLatest([this.votes$, this.search$, this.quadrantSelectedToggle$]);
      }),
      // delay is needed to avoid the error ExpressionChangedAfterItHasBeenCheckedError
      // @todo see if it is possible to remove delay
      delay(0),
      // show in the list only the technologies for which the user has not already cast a vote
      map(([votes, search, quadrant]) => {
        return technologies
          .filter((technology) => votes.find((vote) => vote.technology.name === technology.name) === undefined)
          .filter((technology) => search === '' || technology.name.toLowerCase().includes(search.toLowerCase()))
          .filter((technology) => quadrant === '' || technology.quadrant.toLowerCase() === quadrant.toLowerCase());
      }),
      catchError((err) => {
        logError(err);
        this.router.navigate(['/error']);
        this.errorService.setError(err);
        return EMPTY;
      })
    );
  }

  getTechnologies() {
    const votingEvent = this.voteService.credentials.votingEvent;
    return this.backEnd.getVotingEvent(votingEvent._id).pipe(
      map((event) => {
        let technologies = event.technologies;
        if (votingEvent.openForRevote) {
          technologies = technologies.filter((t) => t.forRevote);
        }
        return _.sortBy(technologies, function(item: Technology) {
          return item.name.toLowerCase();
        });
      })
    );
  }

  getVotesByRing(ring: string): Vote[] {
    return this.votes.filter((v) => v.ring === ring);
  }

  technologySelected(technology: Technology) {
    const votingEventRound = this.voteService.credentials.votingEvent.round;
    if (votingEventRound && votingEventRound > 1) {
      this.goToConversation(technology);
    } else {
      this.openVoteDialog(technology);
    }
  }

  createNewTechnology(name: string, quadrant: string) {
    const votingEvent = this.voteService.credentials.votingEvent;
    const technology: Technology = {
      name: name,
      isnew: true,
      description: '',
      quadrant: quadrant
    };
    this.backEnd.addTechnologyToVotingEvent(votingEvent._id, technology).subscribe((resp) => {
      this.openVoteDialog(technology);
    });
  }

  openVoteDialog(technology: Technology): void {
    let message: string;
    if (this.votes.length === environment.maxNumberOfVotes) {
      message = 'You have already given the max number of votes - cancel one vote if you want to vote for ' + technology.name;
    }
    const dialogRef = this.dialog.open(VoteDialogueComponent, {
      width: '400px',
      maxWidth: '90vw',
      data: { technology, message }
    });

    dialogRef.afterClosed().subscribe((result) => {
      if (result) {
        const vote: Vote = {
          ring: result.ring,
          technology
        };
        if (result.comment) {
          const voteComment: Comment = {
            text: result.comment
          };
          vote.comment = voteComment;
        }
        if (vote.ring) {
          this.addVote(vote);
        }
      }
    });
  }

  goToConversation(technology: Technology) {
    this.voteService.technology = technology;
    this.router.navigate(['vote/conversation']);
  }

  addVote(vote: Vote) {
    this.votes.push(vote);
    this.votes$.next(this.votes);
  }

  removeVote(vote: Vote) {
    const index = this.votes.indexOf(vote);
    this.votes.splice(index, 1);
    this.votes$.next(this.votes);
  }

  saveVotes() {
    this.backEnd.saveVote(this.votes, this.voteService.credentials).subscribe(
      (resp) => {
        if (resp.error) {
          if (resp.error.errorCode === 'V-01') {
            const voterName = this.getVoterFirstLastName(this.voteService.credentials);
            this.messageVote = `<strong> ${voterName} </strong> has already voted`;
          } else {
            this.messageVote = `Vote could not be saved - look at the browser console 
            - maybe there is something there`;
          }
        } else {
          const dialogRef = this.dialog.open(VoteSavedDialogueComponent, {
            width: '400px'
          });

          dialogRef.afterClosed().subscribe((result) => {
            this.router.navigate(['/vote']);
          });
        }
      },
      (err) => {
        logError(err);
        this.messageVote = `Vote could not be saved - look at the browser console 
        - maybe there is something there`;
      }
    );
  }
  getVoterFirstLastName(cred: VoteCredentials) {
    const firstName = cred.voterId.firstName;
    const lastName = cred.voterId.lastName;
    return firstName + ' ' + lastName;
  }

  clearSearch() {
    this.searchField.nativeElement.value = '';
    this.clearSearch$.next('');
  }

  quadrantSelected(quadrant: string) {
    this.quadrantSelected$.next(quadrant);
  }
  isQuadrantSelected(quadrant: string) {
    return this.quadrantSelectedToggle$.pipe(map((q) => q === quadrant));
  }

  truncatedName(name: string) {
    const maxLength = 30;
    let shortName = name;
    if (name.length > maxLength) {
      shortName =
        _(name.substring(0, maxLength).split(' '))
          .tap(function(array) {
            array.pop();
          })
          .join(' ') + '...';
    }
    return shortName;
  }

  isAlreadyVoted(value: string) {
    const existingVote = this.votes.filter((vote) => vote.technology.name === value);
    return existingVote.length !== 0;
  }
}
